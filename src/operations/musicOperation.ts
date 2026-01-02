import { ChatOpenAI, OpenAICallOptions } from "@langchain/openai";
import { CalendarEvent, LocationRecord, SpotifyPlaylist, SpotifyData, MusicContextData } from './types';

/**
 * Music Playing Operation
 * Based on user's current activity, mood, location and music preferences, use large model to analyze user's music list and recommend personalized music
 */

export interface MusicUserData {
  calendar: CalendarEvent[];
  location: LocationRecord[];
  spotify: SpotifyData;
}

export class MusicOperation {
  llm: ChatOpenAI<OpenAICallOptions>;
  userData: MusicUserData;

  constructor(llm: ChatOpenAI<OpenAICallOptions>, userData: MusicUserData) {
    this.llm = llm;
    this.userData = userData;
  }

  /**
   * Play music - Use large model to analyze user music list and recommend playback
   */
  async execute(context?: string): Promise<string> {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDate = now.toISOString().split('T')[0];
    
    // Get current calendar event
    const currentEvent = this.userData.calendar.find((event: CalendarEvent) => 
      event.date === currentDate && 
      parseInt(event.time.split(':')[0]) <= currentHour &&
      parseInt(event.time.split(':')[0]) + (event.duration_hours || 1) >= currentHour
    );

    // Get current location
    const currentLocation = this.userData.location
      .filter((loc: LocationRecord) => loc.timestamp.startsWith(currentDate))
      .sort((a: LocationRecord, b: LocationRecord) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    // Get user's playlists
    const playlists: SpotifyPlaylist[] = this.userData.spotify.playlists;

    // Collect all available music tracks
    const allTracks: Array<{ track: string; playlist: string }> = [];
    playlists.forEach((playlist: SpotifyPlaylist) => {
      playlist.tracks.forEach((track: string) => {
        allTracks.push({
          track,
          playlist: playlist.name
        });
      });
    });

    if (allTracks.length === 0) {
      return "❌ No available music found. Please check your music playlists.";
    }

    // Build context data
    const contextData: MusicContextData = {
      currentTime: `${currentHour}:00`,
      currentDate: currentDate,
      currentActivity: currentEvent ? {
        event: currentEvent.event,
        location: currentEvent.location,
        time: currentEvent.time
      } : "None",
      currentLocation: currentLocation ? currentLocation.location : "Unknown",
      availablePlaylists: playlists.map((p: SpotifyPlaylist) => ({
        name: p.name,
        trackCount: p.tracks.length,
        tracks: p.tracks
      })),
      allTracks: allTracks.map((t: { track: string; playlist: string }) => `${t.track} (from playlist: ${t.playlist})`),
      additionalContext: context || "None"
    };

    // Use LLM to analyze and recommend music
    const prompt = `You are a professional music recommendation expert. Based on the following user data, intelligently analyze and recommend the most suitable music.

User Current Status:
${JSON.stringify(contextData, null, 2)}

Please select the most suitable music from the user's music list to play. Consider the following factors:
1. Current time and activity (morning commute, work time, evening relaxation, etc.)
2. Current location (home, office, market, etc.)
3. Current activity type (work, meeting, sports, social, etc.)
4. User's music preferences and playlist styles

Please select 1-3 most suitable tracks from the user's music list and explain the recommendation reasons.

Please reply in English with the following format:
🎵 Music Recommendation and Playback

Based on your current status:
- Time: [current time]
- Activity: [current activity]
- Location: [current location]

Recommendation reason: [why select these music]

Now Playing:
1. [Track 1] (from playlist: [playlist name])
2. [Track 2] (from playlist: [playlist name]) [if available]
3. [Track 3] (from playlist: [playlist name]) [if available]

Make sure the recommended music actually exists in the user's music list.`;

    try {
    // Call LLM using message format (compatible with Qwen)
    const response = await this.llm.invoke([{ role: "user", content: prompt }]);
    // Normalize possible MessageContent (array or complex object) to string
    let recommendation: string;
    const rawContent = (response as unknown as Record<string, unknown>)?.content;
    if (Array.isArray(rawContent)) {
      recommendation = rawContent
        .map((item: unknown) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const itemObj = item as Record<string, unknown>;
            if (typeof itemObj.text === "string") return itemObj.text;
          }
          return JSON.stringify(item);
        })
        .join('');
    } else if (typeof rawContent === "string") {
      recommendation = rawContent;
    } else if (rawContent && typeof rawContent === "object") {
      const contentObj = rawContent as Record<string, unknown>;
      if (typeof contentObj.text === "string") {
        recommendation = contentObj.text;
      } else {
        recommendation = String(rawContent ?? "");
      }
    } else {
      recommendation = String(rawContent ?? "");
    }

    // Extract track names from recommendation (simple extraction, can be more intelligent in practice)
    const trackMatches = recommendation.match(/\d+\.\s*([^\n(]+)/g);
    const tracksToPlay = trackMatches ? trackMatches.map((m: string) => m.replace(/\d+\.\s*/, '').trim()) : [];

      // Call play function (simulate)
      if (tracksToPlay.length > 0) {
        tracksToPlay.forEach((track: string) => {
          this.simulatePlayMusic(track);
        });
      } else {
        // If no tracks extracted, at least play the first recommended one
        const firstTrack = allTracks[0].track;
        this.simulatePlayMusic(firstTrack);
      }

      return recommendation;
    } catch (error) {
      console.error("Music recommendation error:", error);
      // If LLM call fails, use simple fallback plan
      const fallbackTrack = allTracks[0];
      this.simulatePlayMusic(fallbackTrack.track);
      return `🎵 Now Playing Music\n\nBased on your current status, we recommend:\n\nNow Playing: ${fallbackTrack.track}\nPlaylist: ${fallbackTrack.playlist}\n\n💡 Tip: An error occurred during music recommendation analysis. Default music has been played.`;
    }
  }

  /**
   * Simulate playing music (using console.log)
   */
  simulatePlayMusic(trackName: string): void {
    console.log(`📻 [Simulation Call] Music playback API invoked - Track: ${trackName}`);
  }
}

