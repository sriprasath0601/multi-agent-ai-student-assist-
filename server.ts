import express, { Request, Response } from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { prisma } from './src/backend/db';
import { MultiAgentOrchestrator } from './src/backend/services/orchestrator';

async function startServer() {
  const app = express();
  let PORT = 3000;
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      PORT = parsed;
    }
  } else if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed) && parsed > 0) {
      PORT = parsed;
    }
  }

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // 1. Chat with Multi-Agent Engine
  app.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const { message, studentName } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message string is required' });
      }

      const executionTrace = await MultiAgentOrchestrator.processStudentRequest(message, studentName);
      return res.json(executionTrace);
    } catch (err: any) {
      console.error('API /api/chat error:', err);
      return res.status(500).json({ error: err?.message || 'Agent pipeline failed' });
    }
  });

  // 2. Dashboard aggregate
  app.get('/api/dashboard', async (_req: Request, res: Response) => {
    try {
      const settings = (await prisma.userSettings.findFirst()) || {
        name: '',
        monthlyBudget: 0,
        currency: '₹',
        wakeTime: '07:00',
        sleepTime: '23:30',
      };

      const pendingTasksRaw = await prisma.task.findMany({
        where: { completed: false },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      const pendingTasks = pendingTasksRaw.map((t) => {
        let subtasks: string[] = [];
        try {
          subtasks = JSON.parse(t.subtasks);
        } catch {
          subtasks = [];
        }
        return { ...t, subtasks };
      });

      const allTasks = await prisma.task.findMany({ where: { completed: false } });
      const expenses = await prisma.expense.findMany();
      const totalSpent = expenses.reduce((acc, curr) => acc + (curr.amount || 0), 0);
      const remainingBudget = settings.monthlyBudget > 0 ? Math.max(0, settings.monthlyBudget - totalSpent) : 0;

      const todayStr = new Date().toISOString().split('T')[0];
      const todayPlan = await prisma.planItem.findMany({
        where: { date: todayStr },
        orderBy: { timeSlot: 'asc' },
      });

      const recentLogsRaw = await prisma.agentExecutionLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      const recentLogs = recentLogsRaw.map((l) => {
        let activatedAgents: string[] = [];
        let agentOutputs: any = {};
        try {
          activatedAgents = JSON.parse(l.activatedAgents);
        } catch {
          activatedAgents = [];
        }
        try {
          agentOutputs = JSON.parse(l.agentOutputs);
        } catch {
          agentOutputs = {};
        }
        return { ...l, activatedAgents, agentOutputs };
      });

      return res.json({
        settings,
        stats: {
          pendingTasksCount: allTasks.length,
          totalSpent,
          remainingBudget,
        },
        pendingTasks,
        todayPlan,
        recentLogs,
      });
    } catch (err: any) {
      console.error('API /api/dashboard error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to load dashboard' });
    }
  });

  // 3. Tasks
  app.get('/api/tasks', async (_req: Request, res: Response) => {
    try {
      const raw = await prisma.task.findMany({ orderBy: { createdAt: 'desc' } });
      const tasks = raw.map((t) => {
        let subtasks: string[] = [];
        try {
          subtasks = JSON.parse(t.subtasks);
        } catch {
          subtasks = [];
        }
        return { ...t, subtasks };
      });
      return res.json(tasks);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      const { title, course, priority, estimatedHours, subtasks, dueDate } = req.body;
      const task = await prisma.task.create({
        data: {
          title,
          course: course || 'General',
          priority: priority || 'MEDIUM',
          estimatedHours: Number(estimatedHours) || 1.0,
          subtasks: JSON.stringify(Array.isArray(subtasks) ? subtasks : []),
          dueDate: dueDate || null,
        },
      });
      return res.json({ ...task, subtasks: Array.isArray(subtasks) ? subtasks : [] });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.patch('/api/tasks/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { completed } = req.body;
      const updated = await prisma.task.update({
        where: { id },
        data: { completed: Boolean(completed) },
      });
      return res.json(updated);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // 4. Expenses
  app.get('/api/expenses', async (_req: Request, res: Response) => {
    try {
      const expenses = await prisma.expense.findMany({ orderBy: { date: 'desc' } });
      return res.json(expenses);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/expenses', async (req: Request, res: Response) => {
    try {
      const { title, amount, category, type } = req.body;
      const expense = await prisma.expense.create({
        data: {
          title,
          amount: Number(amount) || 0,
          category: category || 'OTHER',
          type: type || 'EXPENSE',
        },
      });
      return res.json(expense);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // 5. Daily Plan
  app.get('/api/plan', async (req: Request, res: Response) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
      const planItems = await prisma.planItem.findMany({
        where: { date },
        orderBy: { timeSlot: 'asc' },
      });
      return res.json(planItems);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.patch('/api/plan/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { completed } = req.body;
      const updated = await prisma.planItem.update({
        where: { id },
        data: { completed: Boolean(completed) },
      });
      return res.json(updated);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // 6. Execution Activity logs
  app.get('/api/activity', async (_req: Request, res: Response) => {
    try {
      const raw = await prisma.agentExecutionLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      const logs = raw.map((l) => {
        let activatedAgents: string[] = [];
        let agentOutputs: any = {};
        try {
          activatedAgents = JSON.parse(l.activatedAgents);
        } catch {
          activatedAgents = [];
        }
        try {
          agentOutputs = JSON.parse(l.agentOutputs);
        } catch {
          agentOutputs = {};
        }
        return { ...l, activatedAgents, agentOutputs };
      });
      return res.json(logs);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // 7. Conversation History
  app.get('/api/conversations', async (_req: Request, res: Response) => {
    try {
      const records = await prisma.conversation.findMany({
        orderBy: { updatedAt: 'desc' },
      });
      const list = records.map((r) => {
        let agentList: string[] = [];
        let msgCount = 0;
        try {
          agentList = JSON.parse(r.activatedAgents || '[]');
        } catch {
          agentList = [];
        }
        try {
          const parsedMsgs = JSON.parse(r.messages || '[]');
          msgCount = Array.isArray(parsedMsgs) ? parsedMsgs.length : 0;
        } catch {
          msgCount = 0;
        }
        return {
          id: r.id,
          title: r.title,
          preview: r.preview,
          messageCount: msgCount,
          activatedAgents: agentList,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      });
      return res.json(list);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.get('/api/conversations/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const record = await prisma.conversation.findUnique({ where: { id } });
      if (!record) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      let messages: any[] = [];
      let activatedAgents: string[] = [];
      try {
        messages = JSON.parse(record.messages);
      } catch {
        messages = [];
      }
      try {
        activatedAgents = JSON.parse(record.activatedAgents || '[]');
      } catch {
        activatedAgents = [];
      }
      return res.json({
        ...record,
        messages,
        activatedAgents,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/conversations', async (req: Request, res: Response) => {
    try {
      const { id, title, preview, messages, activatedAgents } = req.body;
      if (!id) {
        return res.status(400).json({ error: 'Conversation ID required' });
      }
      const saved = await prisma.conversation.upsert({
        where: { id },
        update: {
          title: title || 'Student Chat Session',
          preview: preview || '',
          messages: JSON.stringify(messages || []),
          activatedAgents: JSON.stringify(activatedAgents || []),
        },
        create: {
          id,
          title: title || 'Student Chat Session',
          preview: preview || '',
          messages: JSON.stringify(messages || []),
          activatedAgents: JSON.stringify(activatedAgents || []),
        },
      });
      return res.json(saved);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await prisma.conversation.delete({ where: { id } });
      return res.json({ success: true, id });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // 8. Settings
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      let settings = await prisma.userSettings.findFirst();
      if (!settings) {
        settings = await prisma.userSettings.create({
          data: {
            name: '',
            monthlyBudget: 0,
            currency: '₹',
            wakeTime: '07:00',
            sleepTime: '23:30',
          },
        });
      }
      return res.json(settings);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  app.post('/api/settings', async (req: Request, res: Response) => {
    try {
      const { name, major, theme, studyHoursTarget, monthlyBudget, currency, wakeTime, sleepTime } = req.body;
      const settings = await prisma.userSettings.upsert({
        where: { id: 'default-student' },
        update: {
          name: name !== undefined ? name : '',
          major: major !== undefined ? major : '',
          theme: theme || 'teal',
          studyHoursTarget: studyHoursTarget !== undefined ? Number(studyHoursTarget) : 3,
          monthlyBudget: monthlyBudget !== undefined ? Number(monthlyBudget) : 0,
          currency: currency || '₹',
          wakeTime: wakeTime || '07:00',
          sleepTime: sleepTime || '23:30',
        },
        create: {
          id: 'default-student',
          name: name || '',
          major: major || '',
          theme: theme || 'teal',
          studyHoursTarget: studyHoursTarget !== undefined ? Number(studyHoursTarget) : 3,
          monthlyBudget: monthlyBudget !== undefined ? Number(monthlyBudget) : 0,
          currency: currency || '₹',
          wakeTime: wakeTime || '07:00',
          sleepTime: sleepTime || '23:30',
        },
      });
      return res.json(settings);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  // Vite Middleware for development & static file serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`✨ Stu-Assist Server with 5-Agent Multi-Agent Engine running on port ${PORT}`);
  });
}

startServer();
