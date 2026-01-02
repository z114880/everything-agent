import { ChatOpenAI, OpenAICallOptions } from "@langchain/openai";
import {
  Notification,
  PriorityInfo,
  ProcessedNotification,
  NotificationStats,
  ProcessedNotificationData,
  NotificationSummaryData,
  CategorizedNotifications,
  ProcessedTodo,
  TodoStats,
  ProcessedTodoData,
  TodoSummaryData,
  LLMAnalysisResult,
  UserData,
  CalendarEvent
} from './types';

/**
 * Analyze Notifications and Todos Operation
 * Support three analysis modes:
 * 1. notifications - analyze application notifications only (sorted by priority)
 * 2. todos - analyze calendar todos only
 * 3. both - analyze both notifications and todos (default)
 */
export class AnalyzeNotificationOperation {
  private llm: ChatOpenAI<OpenAICallOptions>;
  private userData: UserData;

  constructor(llm: ChatOpenAI<OpenAICallOptions>, userData: UserData) {
    this.llm = llm;
    this.userData = userData;
  }

  // ==================== Notification Analysis Methods ====================

  /**
   * Calculate notification priority and time distance
   */
  calculateNotificationPriority(notificationDate: string, notificationTime: string): PriorityInfo {
    const now = new Date();
    
    // Parse notification date and time
    const [year, month, day] = notificationDate.split('-').map(Number);
    const [hour, minute] = notificationTime.split(':').map(Number);
    
    // Create notification time object
    const notificationDateTime = new Date(year, month - 1, day, hour, minute);
    
    // Calculate time difference (milliseconds)
    const timeDiff = now.getTime() - notificationDateTime.getTime();
    
    return {
      timeDiff,
      hoursAgo: Math.floor(timeDiff / (1000 * 60 * 60)),
      minutesAgo: Math.floor((timeDiff / (1000 * 60)) % 60),
      priority: this.getPriority(timeDiff)
    };
  }

  /**
   * Determine priority based on time difference
   * Closer notifications have higher priority
   */
  getPriority(timeDiff: number): 'critical' | 'high' | 'medium' | 'low' {
    const hoursAgo = timeDiff / (1000 * 60 * 60);
    
    if (hoursAgo < 1) {
      return 'critical'; // Critical (less than 1 hour)
    } else if (hoursAgo < 6) {
      return 'high'; // High priority (1-6 hours)
    } else if (hoursAgo < 24) {
      return 'medium'; // Medium priority (6-24 hours)
    } else {
      return 'low'; // Low priority (over 24 hours)
    }
  }

  /**
   * Extract app name from notification message
   */
  extractAppName(message: string): string {
    const appPattern = /^([A-Z_]+):/;
    const match = message.match(appPattern);
    return match ? match[1] : 'UNKNOWN';
  }

  /**
   * Extract notification content (remove app name prefix)
   */
  extractNotificationContent(message: string): string {
    return message.replace(/^[A-Z_]+:\s*/, '');
  }

  /**
   * Process and categorize notifications
   */
  processNotifications(): ProcessedNotificationData {
    const notifications: Notification[] = this.userData.profile.previous_notifications || [];
    
    if (notifications.length === 0) {
      return {
        rawNotifications: [],
        processedNotifications: [],
        categorizedNotifications: {},
        sortedByPriority: [],
        stats: {
          total: 0,
          byApp: {},
          byPriority: {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0
          }
        }
      };
    }

    // Process each notification
    const processedNotifications: ProcessedNotification[] = notifications.map((notification: Notification) => {
      const appName = this.extractAppName(notification.message);
      const content = this.extractNotificationContent(notification.message);
      const priorityInfo = this.calculateNotificationPriority(
        notification.date, 
        notification.time
      );

      return {
        originalMessage: notification.message,
        date: notification.date,
        time: notification.time,
        app: appName,
        content,
        priority: priorityInfo.priority,
        hoursAgo: priorityInfo.hoursAgo,
        minutesAgo: priorityInfo.minutesAgo,
        timeDiff: priorityInfo.timeDiff
      };
    });

    // Sort by priority (critical first)
    const sortedByPriority: ProcessedNotification[] = [...processedNotifications].sort((a: ProcessedNotification, b: ProcessedNotification) => {
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      // Same priority sorted by time (most recent first)
      return b.timeDiff - a.timeDiff;
    });

    // Categorize by app
    const categorizedNotifications: Record<string, ProcessedNotification[]> = {};
    processedNotifications.forEach((notif: ProcessedNotification) => {
      if (!categorizedNotifications[notif.app]) {
        categorizedNotifications[notif.app] = [];
      }
      categorizedNotifications[notif.app].push(notif);
    });

    // Calculate statistics
    const stats: NotificationStats = {
      total: processedNotifications.length,
      byApp: {},
      byPriority: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0
      }
    };

    processedNotifications.forEach((notif: ProcessedNotification) => {
      // Statistics by app
      if (!stats.byApp[notif.app]) {
        stats.byApp[notif.app] = 0;
      }
      stats.byApp[notif.app]++;

      // Statistics by priority
      stats.byPriority[notif.priority]++;
    });

    return {
      rawNotifications: notifications,
      processedNotifications,
      sortedByPriority,
      categorizedNotifications,
      stats
    };
  }

  /**
   * Use large model to analyze notifications
   */
  async analyzeNotificationsWithLLM(processedData: ProcessedNotificationData): Promise<LLMAnalysisResult> {
    const { sortedByPriority, categorizedNotifications, stats } = processedData;

    const notificationSummary: NotificationSummaryData = {
      totalNotifications: stats.total,
      priorityDistribution: stats.byPriority,
      categorizedByApp: Object.entries(categorizedNotifications).reduce((acc: CategorizedNotifications, [app, notifs]: [string, ProcessedNotification[]]) => {
        acc[app] = {
          count: notifs.length,
          notifications: notifs.map((n: ProcessedNotification) => `[${n.priority.toUpperCase()}] ${n.time}: ${n.content}`)
        };
        return acc;
      }, {}),
      mostUrgentNotifications: sortedByPriority.slice(0, 5).map((n: ProcessedNotification) => ({
        app: n.app,
        time: `${n.hoursAgo} hours ${n.minutesAgo} minutes ago`,
        priority: n.priority,
        content: n.content
      }))
    };

    const prompt = `You are a professional notification management and life efficiency advisor. Based on the following user's app notification data, perform analysis and provide suggestions.

User's Notification Data Analysis:
${JSON.stringify(notificationSummary, null, 2)}

User Basic Information:
- Name: ${this.userData.profile.name}
- Profession: ${this.userData.profile.profession}
- Location: ${this.userData.profile.location?.home?.city ?? 'Unknown'}

Please analyze from the following dimensions:

1. **Notification Priority Analysis**
   - Which notifications are most urgent and need immediate attention?
   - Which notifications can be handled later?
   - Are there any notifications requiring immediate action?

2. **Action Suggestions**
   - Based on urgent notifications, what should the user do immediately?
   - Do any notifications need to be replied to?
   - What follow-up tasks need to be scheduled?

3. **Optimization Suggestions**
   - How to improve notification settings to increase work efficiency?
   - What is the recommended notification management strategy?
   - How to balance receiving important notifications and reducing distractions?

Please reply concisely and provide specific, actionable suggestions.`;

    try {
      const response = await this.llm.invoke([
        {
          role: 'user',
          content: prompt
        }
      ]);

      const analysisContent = typeof response.content === 'string' 
        ? response.content 
        : JSON.stringify(response.content);

      return {
        analysis: analysisContent,
        timestamp: new Date().toLocaleString('en-US'),
        count: stats.total
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Analyze Notifications] LLM call failed:', errorMessage);
      throw error;
    }
  }

  /**
   * Generate notification analysis summary
   */
  generateNotificationSummary(processedData: ProcessedNotificationData, llmAnalysis: LLMAnalysisResult): string {
    const { stats, sortedByPriority } = processedData;

    let summary = `📱 Application Notification Analysis Report\n`;
    summary += `${'='.repeat(60)}\n\n`;

    // Statistics
    summary += `📊 Notification Statistics\n`;
    summary += `Total Notifications: ${stats.total}\n`;
    summary += `  ├─ Critical (< 1 hour): ${stats.byPriority.critical}\n`;
    summary += `  ├─ High Priority (1-6 hours): ${stats.byPriority.high}\n`;
    summary += `  ├─ Medium Priority (6-24 hours): ${stats.byPriority.medium}\n`;
    summary += `  └─ Low Priority (> 24 hours): ${stats.byPriority.low}\n\n`;

    // App distribution
    summary += `📲 App Distribution\n`;
    Object.entries(stats.byApp)
      .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
      .forEach(([app, count]: [string, number]) => {
        summary += `  • ${app}: ${count} notifications\n`;
      });
    summary += '\n';

    // Most urgent notifications
    if (sortedByPriority.length > 0) {
      summary += `⚡ Most Urgent Notifications (TOP 3)\n`;
      sortedByPriority.slice(0, 3).forEach((notif: ProcessedNotification, index: number) => {
        summary += `${index + 1}. [${notif.priority.toUpperCase()}] ${notif.app}\n`;
        summary += `   Time: ${notif.hoursAgo} hours ${notif.minutesAgo} minutes ago\n`;
        summary += `   Content: ${notif.content}\n\n`;
      });
    }

    // LLM analysis results
    summary += `\n🤖 Large Model Analysis and Suggestions\n`;
    summary += `${'='.repeat(60)}\n`;
    summary += llmAnalysis.analysis;

    return summary;
  }

  // ==================== Todo Analysis Methods ====================

  /**
   * Process and categorize calendar todos
   */
  processTodos(): ProcessedTodoData {
    const calendar: CalendarEvent[] = this.userData.calendar || [];
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    
    if (calendar.length === 0) {
      return {
        allTodos: [],
        upcomingTodos: [],
        overdueTodos: [],
        todayTodos: [],
        stats: {
          total: 0,
          upcoming: 0,
          overdue: 0,
          today: 0,
          byDate: {}
        }
      };
    }

    // Process each calendar event as a todo
    const processedTodos: ProcessedTodo[] = calendar.map((event: CalendarEvent) => {
      const eventDate = event.date;
      const [eyear, emonth, eday] = eventDate.split('-').map(Number);
      const [ehour, eminute] = (event.time || '00:00').split(':').map(Number);
      
      const eventDateTime = new Date(eyear, emonth - 1, eday, ehour, eminute);
      const timeDiff = eventDateTime.getTime() - now.getTime();
      const hoursUntil = Math.floor(timeDiff / (1000 * 60 * 60));
      const daysUntil = Math.floor(timeDiff / (1000 * 60 * 60 * 24));

      let status: 'overdue' | 'today' | 'upcoming' = 'upcoming';
      let priority: 'critical' | 'high' | 'medium' | 'low' = 'low';
      
      if (timeDiff < 0) {
        status = 'overdue';
        priority = 'critical';
      } else if (eventDate === currentDate) {
        status = 'today';
        priority = 'high';
      } else if (daysUntil <= 3) {
        priority = 'high';
      } else if (daysUntil <= 7) {
        priority = 'medium';
      }

      return {
        event: event.event,
        location: event.location,
        date: eventDate,
        time: event.time,
        duration_hours: event.duration_hours || 1,
        status,
        priority,
        timeDiff,
        hoursUntil,
        daysUntil,
        isToday: eventDate === currentDate
      };
    });

    // Categorize todos
    const overdueTodos = processedTodos.filter((t: ProcessedTodo) => t.status === 'overdue');
    const todayTodos = processedTodos.filter((t: ProcessedTodo) => t.isToday).sort((a: ProcessedTodo, b: ProcessedTodo) => {
      const timeA = parseInt(a.time.split(':')[0]);
      const timeB = parseInt(b.time.split(':')[0]);
      return timeA - timeB;
    });
    const upcomingTodos = processedTodos.filter((t: ProcessedTodo) => t.status === 'upcoming').sort((a: ProcessedTodo, b: ProcessedTodo) => a.timeDiff - b.timeDiff);

    // Calculate statistics
    const stats: TodoStats = {
      total: processedTodos.length,
      upcoming: upcomingTodos.length,
      overdue: overdueTodos.length,
      today: todayTodos.length,
      byDate: {}
    };

    processedTodos.forEach((todo: ProcessedTodo) => {
      if (!stats.byDate[todo.date]) {
        stats.byDate[todo.date] = 0;
      }
      stats.byDate[todo.date]++;
    });

    return {
      allTodos: processedTodos,
      upcomingTodos,
      overdueTodos,
      todayTodos,
      stats
    };
  }

  /**
   * Use large model to analyze todos
   */
  async analyzeTodosWithLLM(processedData: ProcessedTodoData): Promise<LLMAnalysisResult> {
    const { todayTodos, overdueTodos, upcomingTodos, stats } = processedData;

    const todoSummary: TodoSummaryData = {
      totalTodos: stats.total,
      todayTodos: stats.today,
      overdueTodos: stats.overdue,
      upcomingTodos: stats.upcoming,
      todayTasks: todayTodos.map((t: ProcessedTodo) => ({
        event: t.event,
        time: t.time,
        location: t.location,
        duration: t.duration_hours + ' hours'
      })),
      overdueTasks: overdueTodos.slice(0, 5).map((t: ProcessedTodo) => ({
        event: t.event,
        dueDate: t.date,
        location: t.location
      })),
      recentTasks: upcomingTodos.slice(0, 5).map((t: ProcessedTodo) => ({
        event: t.event,
        date: t.date,
        daysUntil: t.daysUntil + ' days'
      }))
    };

    const prompt = `You are a professional task management and life planning advisor. Based on the following user's calendar todo data, perform analysis and provide suggestions.

User's Todo Data Analysis:
${JSON.stringify(todoSummary, null, 2)}

User Basic Information:
- Name: ${this.userData.profile.name}
- Profession: ${this.userData.profile.profession}
- Location: ${this.userData.profile.location?.home?.city ?? 'Unknown'}

Please analyze from the following dimensions:

1. **Urgent Task Analysis**
   - What tasks need to be completed today?
   - Are there any overdue incomplete tasks?
   - What are the most urgent tasks within the next 3 days?

2. **Work Efficiency Suggestions**
   - How to improve task completion rate?
   - Is there a need to reassess workload?
   - What is the recommended work pace?

Please reply concisely and provide specific, actionable suggestions.`;

    try {
      const response = await this.llm.invoke([
        {
          role: 'user',
          content: prompt
        }
      ]);

      const analysisContent = typeof response.content === 'string' 
        ? response.content 
        : JSON.stringify(response.content);

      return {
        analysis: analysisContent,
        timestamp: new Date().toLocaleString('en-US'),
        count: stats.total
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Analyze Todos] LLM call failed:', errorMessage);
      throw error;
    }
  }

  /**
   * Generate todo analysis summary
   */
  generateTodoSummary(processedData: ProcessedTodoData, llmAnalysis: LLMAnalysisResult): string {
    const { todayTodos, overdueTodos, upcomingTodos, stats } = processedData;

    let summary = `📅 Calendar Todo Analysis Report\n`;
    summary += `${'='.repeat(60)}\n\n`;

    // Statistics
    summary += `📊 Task Statistics\n`;
    summary += `Total Tasks: ${stats.total}\n`;
    summary += `  ├─ Today's Tasks: ${stats.today}\n`;
    summary += `  ├─ Overdue Tasks: ${stats.overdue}\n`;
    summary += `  └─ Upcoming: ${stats.upcoming}\n\n`;

    // Overdue tasks warning
    if (overdueTodos.length > 0) {
      summary += `⚠️  Overdue Tasks (${overdueTodos.length} total)\n`;
      overdueTodos.slice(0, 5).forEach((todo: ProcessedTodo, index: number) => {
        summary += `${index + 1}. ${todo.event} (should be completed by ${todo.date})\n`;
        summary += `   Location: ${todo.location}\n`;
      });
      summary += '\n';
    }

    // Today's tasks
    if (todayTodos.length > 0) {
      summary += `📌 Today's Tasks (${todayTodos.length} total)\n`;
      todayTodos.forEach((todo: ProcessedTodo, index: number) => {
        summary += `${index + 1}. ${todo.time} - ${todo.event}\n`;
        summary += `   Location: ${todo.location} | Duration: ${todo.duration_hours}h\n`;
      });
      summary += '\n';
    }

    // Most recent tasks
    if (upcomingTodos.length > 0) {
      summary += `⏰ Most Recent Tasks (TOP 3)\n`;
      upcomingTodos.slice(0, 3).forEach((todo: ProcessedTodo, index: number) => {
        const daysText = todo.daysUntil === 0 ? 'today' : `${Math.abs(todo.daysUntil)} days from now`;
        summary += `${index + 1}. ${todo.event} (${daysText})\n`;
        summary += `   ${todo.date} ${todo.time} @ ${todo.location}\n`;
      });
      summary += '\n';
    }

    // LLM analysis results
    summary += `\n🤖 Large Model Analysis and Suggestions\n`;
    summary += `${'='.repeat(60)}\n`;
    summary += llmAnalysis.analysis;

    return summary;
  }

  // ==================== Comprehensive Analysis Methods ====================

  /**
   * Generate combined summary for notifications and todos
   */
  generateCombinedSummary(
    notificationData: ProcessedNotificationData,
    todoData: ProcessedTodoData,
    notificationAnalysis: LLMAnalysisResult,
    todoAnalysis: LLMAnalysisResult
  ): string {
    let summary = `🎯 Comprehensive Analysis Report (Notifications + Todos)\n`;
    summary += `${'='.repeat(70)}\n\n`;

    // Urgent items summary
    summary += `⚡ Urgent Items Summary\n`;
    const urgentNotifications: ProcessedNotification[] = notificationData.sortedByPriority
      .filter((n: ProcessedNotification) => n.priority === 'critical')
      .slice(0, 3);
    const urgentTodos: ProcessedTodo[] = todoData.overdueTodos.slice(0, 3);
    
    if (urgentNotifications.length > 0) {
      summary += `  Urgent Notifications: ${urgentNotifications.length}\n`;
    }
    if (urgentTodos.length > 0) {
      summary += `  Overdue Tasks: ${urgentTodos.length}\n`;
    }
    if (urgentNotifications.length === 0 && urgentTodos.length === 0) {
      summary += `  ✨ No urgent items\n`;
    }
    summary += '\n';

    // Notification section summary
    summary += `📱 Notification Analysis Overview (${notificationData.stats.total} notifications)\n`;
    summary += `${'─'.repeat(70)}\n`;
    if (notificationData.stats.total > 0) {
      summary += `  Priority Distribution:\n`;
      summary += `    ├─ Critical: ${notificationData.stats.byPriority.critical}\n`;
      summary += `    ├─ High: ${notificationData.stats.byPriority.high}\n`;
      summary += `    ├─ Medium: ${notificationData.stats.byPriority.medium}\n`;
      summary += `    └─ Low: ${notificationData.stats.byPriority.low}\n`;
      
      if (urgentNotifications.length > 0) {
        summary += `\n  Most Urgent Notifications:\n`;
        urgentNotifications.forEach((notif: ProcessedNotification, index: number) => {
          summary += `    ${index + 1}. [${notif.app}] ${notif.content}\n`;
        });
      }
      summary += '\n';
    } else {
      summary += `  ✨ No app notifications\n\n`;
    }

    // Todo section summary
    summary += `📅 Todo Analysis Overview (${todoData.stats.total} tasks)\n`;
    summary += `${'─'.repeat(70)}\n`;
    if (todoData.stats.total > 0) {
      summary += `  Task Distribution:\n`;
      summary += `    ├─ Today: ${todoData.stats.today}\n`;
      summary += `    ├─ Overdue: ${todoData.stats.overdue}\n`;
      summary += `    └─ Upcoming: ${todoData.stats.upcoming}\n`;

      if (todoData.todayTodos.length > 0) {
        summary += `\n  Today's Tasks:\n`;
        todoData.todayTodos.slice(0, 3).forEach((todo: ProcessedTodo, index: number) => {
          summary += `    ${index + 1}. ${todo.time} - ${todo.event}\n`;
        });
      }
      summary += '\n';
    } else {
      summary += `  📅 No todos scheduled yet\n\n`;
    }

    // Comprehensive suggestions
    summary += `\n💡 Comprehensive Analysis and Suggestions\n`;
    summary += `${'='.repeat(70)}\n\n`;

    if (notificationData.stats.total > 0) {
      summary += `Notification Management Suggestions:\n${notificationAnalysis.analysis}\n\n`;
    }

    if (todoData.stats.total > 0) {
      summary += `Task Management Suggestions:\n${todoAnalysis.analysis}\n`;
    }

    return summary;
  }

  // ==================== Main Execution Methods ====================

  /**
   * Execute analysis - supports three modes
   */
  async execute(analysisType: string = 'both'): Promise<string> {
    try {
      console.log(`\n[Analysis] Starting ${analysisType} mode analysis...`);

      // Analyze notifications only
      if (analysisType === 'notifications') {
        console.log('[Analyze Notifications] Processing app notification data...');
        const processedData: ProcessedNotificationData = this.processNotifications();
        console.log(`[Analyze Notifications] Processed ${processedData.stats.total} notifications`);

        if (processedData.stats.total === 0) {
          return '✨ No notification data found, your app notifications are very clean!';
        }

        console.log('[Analyze Notifications] Calling large model for deep analysis...');
        const llmAnalysis: LLMAnalysisResult = await this.analyzeNotificationsWithLLM(processedData);
        const summary: string = this.generateNotificationSummary(processedData, llmAnalysis);
        return summary;
      }

      // Analyze todos only
      else if (analysisType === 'todos') {
        console.log('[Analyze Todos] Processing calendar todo data...');
        const processedData: ProcessedTodoData = this.processTodos();
        console.log(`[Analyze Todos] Processed ${processedData.stats.total} tasks`);

        if (processedData.stats.total === 0) {
          return '📅 No todos scheduled yet!';
        }

        console.log('[Analyze Todos] Calling large model for deep analysis...');
        const llmAnalysis: LLMAnalysisResult = await this.analyzeTodosWithLLM(processedData);
        const summary: string = this.generateTodoSummary(processedData, llmAnalysis);
        return summary;
      }

      // Analyze both (default)
      else if (analysisType === 'both') {
        console.log('[Analysis] Processing notifications and todos simultaneously...');
        
        const notificationData: ProcessedNotificationData = this.processNotifications();
        const todoData: ProcessedTodoData = this.processTodos();
        
        console.log(`[Analysis] Notifications: ${notificationData.stats.total}, Todos: ${todoData.stats.total}`);

        if (notificationData.stats.total === 0 && todoData.stats.total === 0) {
          return '✨ No notifications or todos, your schedule is very clean!';
        }

        // Call large model for analysis
        let notificationAnalysis: LLMAnalysisResult = { analysis: '', timestamp: '', count: 0 };
        let todoAnalysis: LLMAnalysisResult = { analysis: '', timestamp: '', count: 0 };

        if (notificationData.stats.total > 0) {
          console.log('[Analysis] Analyzing notifications...');
          notificationAnalysis = await this.analyzeNotificationsWithLLM(notificationData);
        }

        if (todoData.stats.total > 0) {
          console.log('[Analysis] Analyzing todos...');
          todoAnalysis = await this.analyzeTodosWithLLM(todoData);
        }

        // Generate combined report
        const summary: string = this.generateCombinedSummary(
          notificationData,
          todoData,
          notificationAnalysis,
          todoAnalysis
        );
        return summary;
      }

      return '❌ Invalid analysis type, please choose: notifications, todos or both';

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Analysis] Execution failed:', error);
      return `❌ Analysis failed: ${errorMessage}`;
    }
  }
}
