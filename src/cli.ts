/**
 * Interactive CLI Interface - Support for multi-turn conversations
 * U  // Handle normal user input
  try {
    console.log("\n⏳ Agent is thinking...\n");

    const startTime = Date.now();
    const result = await EverythingAgent(trimmedInput, conversationManager);
    const duration = Date.now() - startTime;

    console.log("Agent: " + result.output);
    console.log(
      `\n[Info] Messages: ${result.messageCount}, Processing time: ${(duration / 1000).toFixed(2)}s`
    );

    promptUser();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Error] Error processing request:", message);
    promptUser();
  }
}y input questions, and the agent will respond based on conversation history
 */

import readline from "readline";
import { EverythingAgent, ConversationManager } from "./index";

// Create readline interface for interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Create global conversation manager
const conversationManager = new ConversationManager(20); // Keep recent 20 messages

/**
 * Prompt user for input
 */
function promptUser() {
  rl.question(
    `\nYou: `,
    (input) => {
      handleUserInput(input);
    }
  );
}

/**
 * Handle user input
 */
async function handleUserInput(input: string) {
  const trimmedInput = input.trim();

  // Handle special commands
  if (trimmedInput.toLowerCase() === "exit") {
    showStatistics();
    console.log(
      "\nGoodbye! 😊 Conversation ended. Thank you for using Everything AI Agent."
    );
    rl.close();
    process.exit(0);
  }

  if (trimmedInput.toLowerCase() === "history") {
    showHistory();
    promptUser();
    return;
  }

  if (trimmedInput.toLowerCase() === "stats") {
    showStatistics();
    promptUser();
    return;
  }

  if (trimmedInput.toLowerCase() === "clear") {
    conversationManager.clearHistory();
    console.log("[System] Conversation history cleared. Starting new conversation.");
    promptUser();
    return;
  }

  if (trimmedInput.toLowerCase() === "help") {
    showHelp();
    promptUser();
    return;
  }

  if (!trimmedInput) {
    console.log("[System] Please enter a valid question");
    promptUser();
    return;
  }

  // Handle normal user input
  try {
    console.log("\n⏳ Agent is thinking...\n");

    const startTime = Date.now();
    const result = await EverythingAgent(trimmedInput, conversationManager);
    const duration = Date.now() - startTime;

    console.log("Agent: " + result.output);
    console.log(
      `\n[Info] Messages: ${result.messageCount}, Processing time: ${(duration / 1000).toFixed(2)}s`
    );

    promptUser();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Error] Error processing request:", message);
    promptUser();
  }
}

/**
 * Display help information
 */
function showHelp() {
  console.log(`
╔════════════════════════════════════════════╗
║         Everything AI Agent - Help         ║
╚════════════════════════════════════════════╝

Available Commands:
  exit      - Exit the program, show conversation statistics
  history   - Show conversation history
  stats     - Show conversation statistics
  clear     - Clear conversation history, start new conversation
  help      - Show this help information

Conversation Tips:
  • Input any question or instruction for multi-turn conversation
  • Agent will remember previous conversation content
  • You can check history or statistics anytime using commands
  `);
}

/**
 * Display conversation history
 */
function showHistory() {
  const history = conversationManager.getFullHistory();
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║        Conversation History (${history.messageCount} messages)        ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);

  if (history.messages.length === 0) {
    console.log("No conversation records\n");
    return;
  }

  history.messages.forEach((msg, index) => {
    const role = msg.role === "user" ? "👤 You" : "🤖 Agent";
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString("en-US")
      : "";
    console.log(`[${index + 1}] ${role} (${timestamp}):`);
    console.log(`    ${msg.content}\n`);
  });
}

/**
 * Display conversation statistics
 */
function showStatistics() {
  const stats = conversationManager.getStatistics();
  const summary = conversationManager.getConversationSummary();

  console.log(`
╔════════════════════════════════════════════╗
║         Conversation Statistics            ║
╚════════════════════════════════════════════╝

📊 Message Statistics:
  • Total Messages: ${stats.totalMessages}
  • User Messages: ${stats.userMessages}
  • Agent Messages: ${stats.assistantMessages}

📈 Average Length:
  • Average User Message Length: ${stats.averageUserMessageLength.toFixed(0)} characters
  • Average Agent Message Length: ${stats.averageAssistantMessageLength.toFixed(0)} characters

⏱️  Time Information:
  • Conversation Duration: ${stats.conversationDurationSeconds} seconds
  `);
}

/**
 * Display welcome message
 */
function showWelcome() {
  console.log(`
╔════════════════════════════════════════════╗
║   Welcome to Everything AI Agent           ║
║   Multi-turn Conversation Interface v1.0   ║
╚════════════════════════════════════════════╝

💡 Tips:
  • Type 'help' to see available commands
  • Type 'exit' to quit the program
  • Type 'history' to see conversation history
  • Type 'stats' to see statistics
  • Type 'clear' to clear conversation history

Let's start the conversation!
  `);
}

/**
 * Start interactive CLI
 */
export async function startInteractiveCLI() {
  showWelcome();
  promptUser();
}

// Main program entry
if (import.meta.url === `file://${process.argv[1]}`) {
  startInteractiveCLI().catch(console.error);
}
