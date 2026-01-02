# Everything AI Agent 🤖

An intelligent AI agent system powered by LLM, designed to be a proactive personal assistant that helps with music recommendations, email management, task analysis, and personalized suggestions.

## Overview

Everything AI Agent is a sophisticated multi-tool conversational AI system that leverages user data (calendar, location, music preferences, social media, etc.) to provide intelligent and contextual assistance. The agent uses LangChain to manage complex tool interactions and maintains conversation history for coherent multi-turn interactions.

## Features

The system comes with four powerful operation tools:

### 1. **Music Recommendation Tool** 🎵
- Analyzes your current activity, mood, location, and music preferences
- Intelligently recommends songs from your Spotify playlists
- Considers calendar events, location data, and time of day
- Provides personalized music selection for work, relaxation, or exercise

### 2. **Email Management Tool** ✉️
- Composes and polishes professional emails with LLM assistance
- Supports multiple email types: business, personal, notification, apology, and follow-up emails
- Automatically improves grammar, tone, and formatting
- Finds recipient information from your contact list
- Simulates email sending with confirmation

### 3. **Notification & Task Analysis Tool** 📋
- Analyzes application notifications with priority assessment
- Categorizes notifications by app and urgency level
- Analyzes calendar todos and tasks
- Provides intelligent action suggestions and management recommendations
- Supports three analysis modes: notifications only, todos only, or both

### 4. **Comprehensive Suggestions Tool** 💡
- Generates personalized life and work suggestions based on all user data
- Analyzes calendar schedules, location history, health metrics, and activity patterns
- Provides focused suggestions on specific areas (health, work, social, etc.)
- Considers sleep quality, fitness data, app usage, and recent purchases
- Delivers actionable recommendations for productivity and well-being

## Project Structure

```
.
├── package.json                 # Project dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── src/
│   ├── index.ts               # Main agent setup and tool creation
│   ├── cli.ts                 # Interactive CLI interface
│   ├── conversationManager.ts # Conversation history management
│   ├── dataLoader.ts          # User data loading
│   ├── device_data/           # Sample user data files
│   │   ├── calendar.csv       # Calendar events
│   │   ├── location.csv       # Location history
│   │   ├── social_media.json  # Social media data
│   │   ├── spotify_playlists.json  # Music preferences
│   │   └── user_profile.json  # User profile information
│   └── operations/            # Tool implementations
│       ├── types.ts           # Type definitions
│       ├── musicOperation.ts           # Music recommendation logic
│       ├── emailOperation.ts           # Email management logic
│       ├── suggestionsOperation.ts     # Suggestion generation logic
│       └── analyzeOperation.ts         # Notification analysis logic
```

## Installation

### Prerequisites
- Node.js (v16 or higher)
- TypeScript
- OpenAI/Qwen API key

### Setup Steps

1. **Clone the project**
```bash
cd everything-agent
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**
Create a `.env` file in the root directory:
```
DASHSCOPE_API_KEY=your_api_key_here
```

4. **Prepare user data** (already included in `src/device_data/`)
   - Place CSV files in the `device_data` directory
   - Ensure JSON files are properly formatted

## Usage

### Interactive Chat Mode

Start the interactive CLI:
```bash
npm run chat
```

The agent will display a prompt and wait for your input. You can have multi-turn conversations with the agent.

### Special Commands

Within the chat interface, you can use these commands:

- `help` - Display available commands
- `history` - Show conversation history
- `stats` - Display conversation statistics
- `clear` - Clear conversation history
- `exit` - Exit the application

## Agent Conversation Examples

### Example 1: Music Recommendation
```
You: I'm at the office working on a presentation today, can you recommend some music?

⏳ Agent is thinking...

Agent: 🎵 Based on your current activity (working on a presentation) and location (office), 
I recommend playing "Focus Flow" playlist which includes:
- "Deep Work" (from Focus Flow playlist)
- "Concentration" (from Ambient playlist)
- "Productivity Boost" (from Electronic playlist)

These tracks are perfect for concentration and maintaining a productive work atmosphere. 
They have minimal lyrics and steady tempo which supports focused work. All tracks are from 
your existing playlists, so you can start playing immediately!

Would you like me to adjust the tempo or mood of the recommendations?
```

### Example 2: Email Composition
```
You: Send an email to John about the project deadline extension request

⏳ Agent is thinking...

Agent: ✉️ I've found John Doe in your contacts and composed a professional email:

**To:** john.doe@company.com
**Subject:** Project Timeline Discussion - Extension Request

**Body:**
Dear John,

I hope this message finds you well. I wanted to reach out regarding the current project 
timeline. I would like to discuss the possibility of extending the deadline to ensure we 
can deliver the highest quality results.

I believe with an additional two weeks, we can significantly improve the project outcomes 
and address potential issues comprehensively. I'm confident this adjustment will benefit 
both our teams in the long run.

Would you be available for a brief call this week to discuss this further?

Best regards,
[Your Name]

---

✅ Email has been polished for professional tone and grammar. Ready to send?
```

### Example 3: Notification Analysis
```
You: Can you analyze my notifications and suggest what I should prioritize today?

⏳ Agent is thinking...

Agent: 📋 **Notification Analysis & Priority Report**

**Critical Priority (Immediate Action):**
- Slack (15 minutes ago): Your urgent code review request from team lead
- Calendar alert (5 minutes ago): Team standup meeting starts in 5 minutes

**High Priority (Today):**
- Gmail (2 hours ago): Client feedback on design mockups
- Jira (3 hours ago): Bug assigned to you with severity HIGH

**Medium Priority (This week):**
- LinkedIn (6 hours ago): Connection request from industry peer
- Github (8 hours ago): PR comments on your contribution

**Recommendations:**
1. ⏰ Join the standup meeting immediately (5 min meeting)
2. 👥 Review the code changes flagged by team lead (15 min)
3. 🐛 Investigate the HIGH severity bug (estimate 30 min)
4. 💬 Review client feedback and design mockups (20 min)
5. 📧 Respond to client feedback before EOD

**Estimated time to clear high-priority items:** ~1.5 hours
**Best time to handle medium priorities:** Tomorrow morning
```

### Example 4: Comprehensive Life Suggestions
```
You: Give me some suggestions to improve my health and productivity this week

⏳ Agent is thinking...

Agent: 💡 **Personalized Health & Productivity Suggestions**

**Health Insights:**
- 📊 You walked 8,432 steps yesterday (slightly below your 10k daily goal)
- 😴 Last night's sleep was 6.5 hours with good quality
- 🏃 Your recent workout was a 5km run yesterday - great effort!

**Recommendations for Health:**
1. Increase daily step count by 2-3k - Try taking walking meetings or walking lunch breaks
2. Schedule a rest day this week - Your workout pattern suggests you might benefit from active recovery
3. Maintain current sleep quality - Your 10:30 PM bedtime is optimal for your schedule
4. Add strength training 2x this week to complement your running routine

**Productivity Insights:**
- 📅 You have 6 meetings scheduled this week - significant context switching overhead
- 💻 App usage shows Slack is consuming 4+ hours daily
- 📈 Your typical productive hours are 9-11 AM and 2-4 PM

**Recommendations for Productivity:**
1. **Deep work blocks:** Protect your 9-11 AM window - No meetings during this time
2. **Communication windows:** Batch check Slack at 12:00, 3:00, 5:00 PM only
3. **Meeting optimization:** Try to consolidate Tuesday's 4 separate meetings into 2 longer ones
4. **Energy management:** Your afternoon dip happens at 3-4 PM - save routine tasks for this window
5. **Focus setup:** Based on your preferences, I recommend "Lo-Fi Hip Hop" playlist for deep work

**Action Plan for This Week:**
- Mon: 10k steps target + 30min meeting consolidation
- Tue-Wed: Protect morning hours + start strength training
- Thu-Fri: Review progress + plan weekend activity
```

### Example 5: Context-Aware Multi-Turn Conversation
```
You: I have a busy day tomorrow, what should I listen to while commuting?

Agent: 🎵 Based on your schedule tomorrow, you have:
- 8:00 AM - Standup meeting (office)
- 10:00 AM - Client presentation (downtown)
- 2:00 PM - Team brainstorm (office)

For your commute, I recommend "Travel Playlist" with upbeat and energizing tracks to keep 
you motivated. Estimated commute time is 45 minutes, perfect for 3-4 songs.

---

You: What songs are in the Travel Playlist exactly?

Agent: 🎵 Here are the tracks in your Travel Playlist:
1. "Morning Sunshine" - Great for starting your commute with positive energy
2. "Urban Explorer" - Energetic track perfect for mid-commute
3. "Commute Chronicles" - Uplifting beat to maintain momentum
4. "Arrival Boost" - Energizing final track to arrive at work ready to present

These are all from your existing collection. The total duration is approximately 18 minutes, 
so you might want to loop it once, or I can recommend the Workout Motivation playlist as 
a follow-up to fill the remaining commute time?

---

You: Perfect! By the way, can you send my client a confirmation email about tomorrow's presentation?

Agent: ✉️ I found Sarah Johnson (your main client contact) in your contacts. Here's the 
polished confirmation email:

**To:** sarah.johnson@clientcorp.com
**Subject:** Confirmation: Client Presentation - Tomorrow at 10:00 AM

**Body:**
Dear Sarah,

I hope you're having a great week. I'm writing to confirm our presentation scheduled for 
tomorrow at 10:00 AM. I'm excited to share our latest deliverables and gather your feedback.

I will arrive at your downtown office by 9:45 AM. Please let me know if you need any 
technical setup assistance or have specific topics you'd like us to prioritize.

Looking forward to our discussion!

Best regards,
[Your Name]

---

✅ Email ready to send to Sarah Johnson!
```

## Data Sources

The agent uses the following data files to provide personalized recommendations:

### Calendar Data (`calendar.csv`)
- Events with dates, times, locations, and durations
- Used for activity context in music and suggestion recommendations

### Location History (`location.csv`)
- Timestamped location records
- Enables location-aware suggestions and recommendations

### Spotify Playlists (`spotify_playlists.json`)
- User's music playlists and track lists
- Source data for music recommendations

### User Profile (`user_profile.json`)
Contains:
- Basic information (name, age, profession)
- Contact information and email addresses
- Fitness/health data (steps, sleep, workout information)
- Location preferences (home, work)
- Purchase history
- App usage statistics
- Previous notifications

### Social Media (`social_media.json`)
- Social media engagement data
- Used for comprehensive suggestion generation

## Configuration

### Conversation Management
- Maintains conversation history for context-aware responses
- Default history window: 20 recent messages
- Supports clearing history with `clear` command

## Architecture

### Core Components

1. **LangChain Agent** (`index.ts`)
   - Creates the main agent executor with all tools
   - Sets up system prompts and prompt templates
   - Handles tool calling and response generation

2. **Conversation Manager** (`conversationManager.ts`)
   - Manages multi-turn conversation history
   - Maintains message count and conversation flow
   - Supports history clearing and retrieval

3. **Data Loader** (`dataLoader.ts`)
   - Loads user data from CSV and JSON files
   - Prepares data in the format required by operations
   - Handles data parsing and validation

4. **CLI Interface** (`cli.ts`)
   - Provides interactive command-line interface
   - Supports special commands (history, stats, clear, help)
   - Displays agent responses with timing information

## API Integration

The agent integrates with:

- **LLM**: For natural language understanding and generation
- **LangChain**: For agent orchestration, tool management, and conversation flow
- **Local Data**: CSV and JSON files for user information

## Error Handling

The application includes error handling for:
- Invalid email formats
- Missing user data
- API call failures
- Conversation processing errors

Errors are caught and displayed gracefully in the CLI with helpful context.

## Environment Variables

Create a `.env` file with:

```env
# Required
DASHSCOPE_API_KEY=your_api_key_here

## Performance Considerations

- **Message Processing Time**: Typically 2-5 seconds per query (depending on LLM response time)
- **Conversation Memory**: Maintains last 20 messages for context
- **Data Loading**: User data is loaded once at startup
- **Tool Execution**: Runs sequentially; largest operations are LLM calls

## Development

### Building
TypeScript files are compiled on-the-fly using `tsx`:
```bash
npm run dev
```

### Dependencies
- `@langchain/core`: Core LangChain abstractions
- `@langchain/openai`: OpenAI/Qwen integration
- `@langchain/community`: Community tools and integrations
- `langchain`: Main LangChain library
- `zod`: Type validation and schema definition
- `dotenv`: Environment variable management
- `express` & `cors`: For potential API server integration

## Future Enhancements

Potential features for future development:

1. **Persistent Storage**: Save conversation history to database
2. **API Server**: REST API endpoints for remote agent access
3. **Real-time Notifications**: Integrate with actual notification systems
4. **Calendar Integration**: Direct Google Calendar/Outlook sync
5. **Email Sending**: Real SMTP integration for actual email sending
6. **Multi-language Support**: Support for Chinese, Spanish, and other languages
7. **Advanced Analytics**: Detailed usage patterns and insights
8. **Custom Tool Creation**: User-defined tools and workflows
9. **Scheduling**: Automated tasks at specific times or conditions
10. **Voice Interface**: Speech-to-text and text-to-speech capabilities

## License

MIT License - feel free to use this project for personal or commercial purposes.

## Contributing

Contributions are welcome! Feel free to:
- Report bugs and issues
- Suggest new features
- Submit pull requests with improvements
- Improve documentation

## Support

For issues, questions, or suggestions, please create an issue in the repository.

---

**Made with ❤️ for intelligent personal assistance**
