import { ChatOpenAI, OpenAICallOptions } from "@langchain/openai";
import { SuggestionsUserData, CalendarEvent, LocationRecord, Notification, Purchase } from './types';

/**
 * Comprehensive Suggestion Generation Operation
 * Based on all user data (calendar, location, social media, health data, etc.), generate comprehensive life and work suggestions
 */
export class SuggestionsOperation {
  private llm: ChatOpenAI<OpenAICallOptions>;
  private userData: SuggestionsUserData;

  constructor(llm: ChatOpenAI<OpenAICallOptions>, userData: SuggestionsUserData) {
    this.llm = llm;
    this.userData = userData;
  }

  /**
   * Generate comprehensive suggestions - use large model for intelligent generation
   */
  async execute(focus: string | null = null): Promise<unknown> {
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentHour = now.getHours();

    // Collect all relevant data
    const todayEvents: CalendarEvent[] = this.userData.calendar.filter((e: CalendarEvent) => e.date === currentDate);
    const upcomingEvents: CalendarEvent[] = todayEvents.filter((e: CalendarEvent) => 
      parseInt(e.time.split(':')[0]) > currentHour
    );
    const pastEvents: CalendarEvent[] = todayEvents.filter((e: CalendarEvent) => 
      parseInt(e.time.split(':')[0]) + (e.duration_hours || 0) < currentHour
    );

    const currentLocation = this.userData.location
      .filter((loc: LocationRecord) => loc.timestamp.startsWith(currentDate))
      .sort((a: LocationRecord, b: LocationRecord) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    const fitnessData = this.userData.profile.fitness_data;
    const recentNotifications = (this.userData.profile.previous_notifications ?? []).slice(-10);
    const recentPurchases = (this.userData.profile.purchases ?? []).slice(0, 5);
    const appUsage = this.userData.profile.app_usage;

    // Build comprehensive data summary
    const userContext = {
      basicInfo: {
        name: this.userData.profile.name,
        age: this.userData.profile.age,
        profession: this.userData.profile.profession,
        location: this.userData.profile.location?.home?.city ?? 'Unknown'
      },
      currentTime: {
        date: currentDate,
        time: `${currentHour}:00`,
        day: new Date().toLocaleDateString('en-US', { weekday: 'long' })
      },
      todaySchedule: {
        completed: pastEvents.map((e: CalendarEvent) => `${e.time} - ${e.event} (${e.location})`),
        upcoming: upcomingEvents.map((e: CalendarEvent) => `${e.time} - ${e.event} (${e.location})`),
        nextEvent: upcomingEvents.length > 0 ? {
          time: upcomingEvents[0].time,
          event: upcomingEvents[0].event,
          location: upcomingEvents[0].location,
          inHours: `${parseInt(upcomingEvents[0].time.split(':')[0]) - currentHour} hours`
        } : "None"
      },
      currentLocation: currentLocation ? {
        location: currentLocation.location,
        timestamp: currentLocation.timestamp
      } : "Unknown",
      healthData: {
        stepsToday: fitnessData.steps_today,
        sleep: {
          duration: fitnessData.sleep.last_night,
          quality: fitnessData.sleep.quality
        },
        recentWorkout: {
          type: fitnessData.last_workout.type,
          distance: fitnessData.last_workout.distance_km + "km",
          feeling: fitnessData.last_workout.felt
        }
      },
      appUsage: {
        mostUsedApps: appUsage.most_used_apps,
        lastOpenedApp: appUsage.last_opened_app,
        screenTime: appUsage.screen_time
      },
      recentNotifications: recentNotifications.map((n: Notification) => `${n.date} ${n.time}: ${n.message}`),
      purchaseHistory: recentPurchases.map((p: Purchase) => `${p.item} - ${p.price} (${p.store}, ${p.date})`),
      socialMediaActivity: this.userData.socialMedia.twitter.recent_posts
    };

    // Build prompt
    let focusInstruction = "";
    if (focus) {
      focusInstruction = `\nPlease focus on suggestions in the "${focus}" area.`;
    } else {
      focusInstruction = "\nPlease provide comprehensive suggestions covering work efficiency, health, social, and life aspects.";
    }

    const prompt = `You are a professional life and work efficiency advisor. Based on the following complete user data, generate personalized and practical comprehensive suggestions.

Complete User Data:
${JSON.stringify(userContext, null, 2)}
${focusInstruction}

Please analyze and provide suggestions from the following dimensions:
1. Work Efficiency - Based on current schedule, location, app usage, etc.
2. Healthy Living - Based on steps, sleep, workout data, etc.
3. Social Activities - Based on schedule, notifications, etc.
4. Life Balance - Based on overall data, provide suggestions for balancing work and life

Please reply in English with the following format:
💡 Comprehensive Suggestions

${focus ? `Focus area: ${focus}\n` : ''}Based on your current status, I provide you with the following suggestions:

📊 Work Efficiency Suggestions:
- [Suggestion 1]
- [Suggestion 2]
- [Suggestion 3]

🏃 Health Suggestions:
- [Suggestion 1]
- [Suggestion 2]
- [Suggestion 3]

👥 Social Suggestions:
- [Suggestion 1]
- [Suggestion 2]

⚖️ Life Balance Suggestions:
- [Suggestion 1]
- [Suggestion 2]

Please ensure suggestions:
- Are specific and actionable
- Based on user's actual data
- Are personalized and targeted
- Are positive and encouraging`;

    try {
      // Call LLM using message format (compatible with Qwen)
      const response = await this.llm.invoke([{ role: "user", content: prompt }]);
      console.log(response.content)
      return response.content;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Error generating suggestions:", error);
      return `❌ Error occurred while generating suggestions: ${errorMessage}\n\nPlease try again later.`;
    }
  }
}

