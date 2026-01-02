/**
 * Type definitions for analysis operations
 */

// ==================== Notification Related Types ====================

export interface Notification {
  message: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
}

export interface PriorityInfo {
  timeDiff: number;
  hoursAgo: number;
  minutesAgo: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface ProcessedNotification {
  originalMessage: string;
  date: string;
  time: string;
  app: string;
  content: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  hoursAgo: number;
  minutesAgo: number;
  timeDiff: number;
}

export interface NotificationStats {
  total: number;
  byApp: Record<string, number>;
  byPriority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface ProcessedNotificationData {
  rawNotifications: Notification[];
  processedNotifications: ProcessedNotification[];
  sortedByPriority: ProcessedNotification[];
  categorizedNotifications: Record<string, ProcessedNotification[]>;
  stats: NotificationStats;
}

// ==================== Todo Related Types ====================

export interface CalendarEvent {
  event: string;
  location: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  duration_hours?: number;
}

export interface ProcessedTodo {
  event: string;
  location: string;
  date: string;
  time: string;
  duration_hours: number;
  status: 'overdue' | 'today' | 'upcoming';
  priority: 'critical' | 'high' | 'medium' | 'low';
  timeDiff: number;
  hoursUntil: number;
  daysUntil: number;
  isToday: boolean;
}

export interface TodoStats {
  total: number;
  upcoming: number;
  overdue: number;
  today: number;
  byDate: Record<string, number>;
}

export interface ProcessedTodoData {
  allTodos: ProcessedTodo[];
  upcomingTodos: ProcessedTodo[];
  overdueTodos: ProcessedTodo[];
  todayTodos: ProcessedTodo[];
  stats: TodoStats;
}

// ==================== LLM Analysis Result ====================

export interface LLMAnalysisResult {
  analysis: string;
  timestamp: string;
  count: number;
}

// ==================== User Data Related Types ====================

export interface LocationInfo {
  home?: {
    city?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface UserProfile {
  name: string;
  profession: string;
  email?: string;
  contacts?: Contact[];
  location?: LocationInfo;
  previous_notifications?: Notification[];
  [key: string]: any;
}

export interface UserData {
  profile: UserProfile;
  calendar?: CalendarEvent[];
  [key: string]: any;
}

// ==================== Notification Summary Types ====================

export interface NotificationSummaryItem {
  app: string;
  time: string;
  priority: string;
  content: string;
}

export interface CategorizedNotifications {
  [app: string]: {
    count: number;
    notifications: string[];
  };
}

export interface NotificationSummaryData {
  totalNotifications: number;
  priorityDistribution: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  categorizedByApp: CategorizedNotifications;
  mostUrgentNotifications: NotificationSummaryItem[];
}

// ==================== Todo Summary Types ====================

export interface TodoSummaryItem {
  event: string;
  time?: string;
  location?: string;
  duration?: string;
  dueDate?: string;
  distance?: string;
  date?: string;
}

export interface TodoSummaryData {
  totalTodos: number;
  todayTodos: number;
  overdueTodos: number;
  upcomingTodos: number;
  todayTasks: TodoSummaryItem[];
  overdueTasks: TodoSummaryItem[];
  recentTasks: TodoSummaryItem[];
}

// ==================== Email Related Types ====================

export interface Contact {
  name: string;
  email: string;
  [key: string]: any;
}

export interface EmailRecipientInfo {
  email: string | null;
  name: string | null;
  found: boolean;
}

export interface EmailSendOptions {
  name: string;
  subject: string;
  content: string;
  emailType?: 'business' | 'personal' | 'notification' | 'apology' | 'followup' | 'general';
}

export interface EmailSendResult {
  success: boolean;
  error?: string;
  recipientEmail: string | null;
}

// ==================== Music Related Types ====================

export interface SpotifyTrack {
  [key: string]: any;
}

export interface SpotifyPlaylist {
  name: string;
  tracks: string[];
}

export interface SpotifyData {
  playlists: SpotifyPlaylist[];
  [key: string]: any;
}

export interface LocationRecord {
  timestamp: string;
  location: string;
  [key: string]: any;
}

export interface MusicContextData {
  currentTime: string;
  currentDate: string;
  currentActivity: Record<string, unknown> | string;
  currentLocation: string;
  availablePlaylists: Array<{
    name: string;
    trackCount: number;
    tracks: string[];
  }>;
  allTracks: string[];
  additionalContext: string;
}

// ==================== Suggestion Related Types ====================

export interface FitnessData {
  steps_today: number;
  sleep: {
    last_night: string;
    quality: string;
  };
  last_workout: {
    type: string;
    distance_km: number;
    felt: string;
  };
  [key: string]: any;
}

export interface AppUsageData {
  most_used_apps: string[];
  last_opened_app: string;
  screen_time: string;
  [key: string]: any;
}

export interface Purchase {
  item: string;
  price: string;
  store: string;
  date: string;
  [key: string]: any;
}

export interface SocialMediaData {
  twitter: {
    recent_posts: string[];
    [key: string]: any;
  };
  [key: string]: any;
}

export interface SuggestionsUserData {
  profile: UserProfile & {
    age?: number;
    fitness_data: FitnessData;
    purchases: Purchase[];
    app_usage: AppUsageData;
  };
  calendar: CalendarEvent[];
  location: LocationRecord[];
  socialMedia: SocialMediaData;
  [key: string]: any;
}
