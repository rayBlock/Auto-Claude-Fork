import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { registerTaskCRUDHandlers } from '../crud-handlers';

// Mocks for local dependencies
vi.mock('../../project-store', () => ({
    projectStore: {
        getProject: vi.fn(),
        getProjects: vi.fn(),
        getTasks: vi.fn(),
        invalidateTasksCache: vi.fn(),
    }
}));

vi.mock('../../title-generator', () => ({
    titleGenerator: {
        generateTitle: vi.fn(),
    }
}));

vi.mock('../shared', () => ({
    findTaskAndProject: vi.fn(),
}));

// Mock sentry to prevent it from loading real electron
vi.mock('../../../sentry', () => ({
    initializeSentry: vi.fn(),
}));

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
}));

import { ipcMain } from 'electron';
import { findTaskAndProject } from '../shared';

describe('Task Reset Logic in TASK_UPDATE', () => {
    let mockAgentManager: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockAgentManager = {
            isRunning: vi.fn(),
        };
        registerTaskCRUDHandlers(mockAgentManager);
    });

    const setupMocks = (taskOverrides = {}, planContent = {}) => {
        const taskId = 'test-task';
        const projectId = 'test-project';
        const projectPath = '/test/project';
        const specId = '001-test';

        const task = {
            id: taskId,
            specId: specId,
            status: 'backlog',
            description: 'old description',
            title: 'Test Feature',
            ...taskOverrides
        };

        const project = {
            id: projectId,
            path: projectPath,
            autoBuildPath: '.auto-claude'
        };

        (findTaskAndProject as any).mockReturnValue({ task, project });
        (fs.existsSync as any).mockImplementation((p: string) => {
            if (p.includes('specs') || p.includes('implementation_plan.json')) return true;
            return false;
        });

        const plan = {
            feature: 'Test Feature',
            description: 'old description',
            phases: [
                {
                    subtasks: [
                        { id: 'st1', status: 'completed', actual_output: 'done' }
                    ]
                }
            ],
            ...planContent
        };

        (fs.readFileSync as any).mockReturnValue(JSON.stringify(plan));

        return { taskId, projectId, plan };
    };

    it('should reset subtasks and clear metadata when description changes and task is in backlog', async () => {
        const { taskId } = setupMocks({ status: 'backlog' }, { recoveryNote: 'stuck' });
        mockAgentManager.isRunning.mockReturnValue(false);

        // First arg is event ({}), second is taskId, third is updates
        const result = await (ipcMain as any).invokeHandler('task:update', {}, taskId, {
            description: 'new description'
        });

        if (!result.success) {
            throw new Error(`Task update failed with error: ${result.error}`);
        }

        expect(result.success).toBe(true);

        const writeCall = (fs.writeFileSync as any).mock.calls.find((call: any) =>
            call[0].includes('implementation_plan.json')
        );
        expect(writeCall, 'Plan should have been written').toBeDefined();

        const savedPlan = JSON.parse(writeCall[1]);
        expect(savedPlan.phases[0].subtasks[0].status).toBe('pending');
        expect(savedPlan.phases[0].subtasks[0].actual_output).toBeUndefined();
        expect(savedPlan.status).toBe('pending');
        expect(savedPlan.planStatus).toBe('pending');
        expect(savedPlan.recoveryNote).toBeUndefined();

        // Verify QA files were tried to be deleted
        expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should NOT reset subtasks if agent is running', async () => {
        const { taskId } = setupMocks({ status: 'backlog' });
        mockAgentManager.isRunning.mockReturnValue(true);

        const result = await (ipcMain as any).invokeHandler('task:update', {}, taskId, {
            description: 'new description'
        });
        expect(result.success).toBe(true);

        const writeCall = (fs.writeFileSync as any).mock.calls.find((call: any) =>
            call[0].includes('implementation_plan.json')
        );
        expect(writeCall).toBeDefined();
        const savedPlan = JSON.parse(writeCall[1]);
        expect(savedPlan.phases[0].subtasks[0].status).toBe('completed');
    });

    it('should NOT reset subtasks if task is in "done" status', async () => {
        const { taskId } = setupMocks({ status: 'done' });
        mockAgentManager.isRunning.mockReturnValue(false);

        const result = await (ipcMain as any).invokeHandler('task:update', {}, taskId, {
            description: 'new description'
        });
        expect(result.success).toBe(true);

        const writeCall = (fs.writeFileSync as any).mock.calls.find((call: any) =>
            call[0].includes('implementation_plan.json')
        );
        expect(writeCall).toBeDefined();
        const savedPlan = JSON.parse(writeCall[1]);
        expect(savedPlan.phases[0].subtasks[0].status).toBe('completed');
    });

    it('should reset subtasks if status is "error"', async () => {
        const { taskId } = setupMocks({ status: 'error' });
        mockAgentManager.isRunning.mockReturnValue(false);

        const result = await (ipcMain as any).invokeHandler('task:update', {}, taskId, {
            description: 'new description'
        });
        expect(result.success).toBe(true);

        const writeCall = (fs.writeFileSync as any).mock.calls.find((call: any) =>
            call[0].includes('implementation_plan.json')
        );
        expect(writeCall).toBeDefined();
        const savedPlan = JSON.parse(writeCall[1]);
        expect(savedPlan.phases[0].subtasks[0].status).toBe('pending');
    });
});
