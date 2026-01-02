import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import { DataLoader } from "./dataLoader.ts";
import { MusicOperation } from "./operations/musicOperation.ts";
import { SuggestionsOperation } from "./operations/suggestionsOperation.ts";
import { EmailOperation } from "./operations/emailOperation.ts";
import { AnalyzeNotificationOperation } from "./operations/analyzeOperation.ts";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ConversationManager } from "./conversationManager.ts";

// Load environment variables
dotenv.config();

// Create Qwen chat model instance
const model = new ChatOpenAI({
  modelName: "qwen-plus",
  temperature: 0.7,
  openAIApiKey: process.env.DASHSCOPE_API_KEY,
  configuration: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
});

/**
 * Create tool set
 */
async function createTools(userData: any) {
  // Create operation instances
  const musicOperation = new MusicOperation(model, userData);
  const suggestionsOperation = new SuggestionsOperation(model, userData);
  const emailOperation = new EmailOperation(model, userData);
  const analyzeNotificationOperation = new AnalyzeNotificationOperation(model, userData);

  return [
    // Play music tool
    new DynamicStructuredTool({
      name: "play_music",
      description:
        "Based on the user's current activity, mood, location and music preferences, use the large model to analyze the user's music list and recommend playing personalized music. Analyze user calendar events, location, music playlist and other data to intelligently select the most suitable music to play.",
      schema: z.object({
        context: z
          .string()
          .nullable()
          .optional()
          .describe("Optional context information, such as current activity or mood"),
      }),
      func: async ({ context }: { context?: string | null | undefined }) => {
        return await musicOperation.execute(context ?? undefined);
      },
    }),

    // Generate comprehensive suggestions tool
    new DynamicStructuredTool({
      name: "generate_suggestions",
      description:
        "Based on all user data (calendar, location, social media, health data, etc.), generate comprehensive life and work suggestions.",
      schema: z.object({
        focus: z
          .string()
          .nullable()
          .optional()
          .describe("Focus area for suggestions, such as 'work efficiency', 'health', 'social', etc."),
      }),
      func: async ({ focus }: { focus?: string | null | undefined }) => {
        return await suggestionsOperation.execute(focus ?? null);
      },
    }),

    // Send email tool
    new DynamicStructuredTool({
      name: "send_email",
      description:
        "Send emails after polishing the content using a large language model. Can handle various types of emails: business emails, personal emails, notifications, apology emails, etc. The system automatically improves grammar, tone and format to ensure professional and clear emails.",
      schema: z.object({
        name: z.string().describe("Recipient name, for example John Doe"),
        subject: z.string().describe("Email subject/title"),
        content: z.string().describe("Email body content"),
        emailType: z
          .enum(["business", "personal", "notification", "apology", "followup", "general"])
          .nullable()
          .optional()
          .describe("Email type to determine polish style. Defaults to 'general'"),
      }),
      func: async ({ name, subject, content, emailType }: { name: string; subject: string; content: string; emailType?: string | null | undefined }) => {
        return await emailOperation.execute({ name, subject, content, emailType: emailType ?? "general" });
      },
    }),

    // Analyze notifications and todos tool
    new DynamicStructuredTool({
      name: "analyze_notifications_and_todos",
      description:
        "Analyze application notifications or calendar todos. Can analyze app notifications (sorted by time priority, closer ones have higher priority), or analyze tasks in the calendar, and use the large model to generate targeted action suggestions and management suggestions.",
      schema: z.object({
        analysisType: z
          .enum(["notifications", "todos", "both"])
          .nullable()
          .optional()
          .describe("Analysis type: 'notifications' (analyze app notifications only), 'todos' (analyze calendar todos only), 'both' (analyze both), defaults to 'both'"),
      }),
      func: async ({ analysisType }: { analysisType?: string | null | undefined }) => {
        return await analyzeNotificationOperation.execute(analysisType ?? undefined);
      },
    }),
  ];
}

async function EverythingAgent(userInput: string, conversationManager: ConversationManager | null = null): Promise<any> {
  // If no conversation manager is provided, create a new one
  if (!conversationManager) {
    conversationManager = new ConversationManager();
  }

  const dataLoader = new DataLoader();
  const userData = await dataLoader.loadAll();
  const tools = await createTools(userData);

  // Add user message to conversation history
  conversationManager.addUserMessage(userInput);

  // Get conversation history and context information
  const conversationSummary = conversationManager.getConversationSummary();
  const previousContext = conversationSummary.lastUserMessage
    ? "\n\n[Previous Conversation Context]"
    : "";

  // Create prompt template with conversation history
  const messages: any[] = [
    [
      "system",
      `You are an intelligent assistant named Everything AI Agent. Your task is to help user Dan manage his daily life.

Current User Information:
- Name: ${userData.profile.name}
- Age: ${userData.profile.age}
- Profession: ${userData.profile.profession}
- Location: ${userData.profile.location.home.city}, ${userData.profile.location.home.country}

You can perform the following operations:
1. Play music - Based on user's current activity, mood and location, recommend and play personalized music
2. Generate comprehensive suggestions - Provide personalized suggestions for life and work efficiency
3. Send email - Polish email content using large language models and send emails. Support multiple email types (business, personal, notification, apology, follow-up, etc.)
4. Analyze notifications and todos - Analyze app notifications or calendar todos, generate priority sorting and action suggestions

Intelligently select appropriate tools to execute operations based on user questions. If the user's question is unclear, first analyze the context and then perform the most appropriate operation.

Current time: ${new Date().toLocaleString("en-US", {
        timeZone: "Europe/London",
      })}

[Multi-turn Conversation Information]
- Messages processed: ${conversationSummary.totalMessages}
- Conversation duration: ${Math.floor(conversationSummary.conversationDuration / 1000)} seconds

${conversationSummary.lastUserMessage
        ? `Previous user message: "${conversationSummary.lastUserMessage.content}"`
        : ""
      }

Please answer the user's question based on complete conversation history and maintain conversation coherence.${previousContext}`,
    ],
  ];

  // Add conversation history messages
  conversationManager.getFormattedMessages().forEach((msg: any) => {
    messages.push([msg.role === "human" ? "user" : "assistant", msg.content]);
  });

  // Add current input prompt
  messages.push(["human", "{input}"]);
  messages.push(new MessagesPlaceholder("agent_scratchpad"));

  const prompt = ChatPromptTemplate.fromMessages(messages);

  // Create agent
  const agent = await createToolCallingAgent({
    llm: model,
    tools,
    prompt,
  });

  // Create agent executor
  const agentExecutor = new AgentExecutor({
    agent,
    tools,
    verbose: false,
    maxIterations: 5,
    handleParsingErrors: true,
  });

  try {
    // Invoke model
    const response = await agentExecutor.invoke({ input: userInput });
    const output = response.output;

    conversationManager.addAssistantMessage(output);

    return {
      output,
      conversationManager,
      conversationId: (conversationManager as any).state.conversationId,
      messageCount: (conversationManager as any).state.messageCount,
    };
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

// Main function
async function main() {
  const userInput = process.argv[2] || "Hello, please introduce yourself";

  console.log("User input:", userInput);
  console.log("\nAgent output:");

  const result = await EverythingAgent(userInput);
  console.log(result.output);
}

// Export EverythingAgent and ConversationManager for external use
export { EverythingAgent, ConversationManager };
