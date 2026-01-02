import { ChatOpenAI, OpenAICallOptions } from "@langchain/openai";
import {
  Contact,
  EmailRecipientInfo,
  EmailSendOptions,
  EmailSendResult,
  UserData
} from './types';

/**
 * Email Sending Operation
 * Support:
 * 1. Recipient parsing (email format or contact name)
 * 2. Use large model to polish email content
 * 3. Simulate sending process
 */

export class EmailOperation {
  private llm: ChatOpenAI<OpenAICallOptions>;
  private userData: UserData;

  constructor(llm: ChatOpenAI<OpenAICallOptions>, userData: UserData) {
    this.llm = llm;
    this.userData = userData;
  }

  /**
   * Validate email format
   */
  isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Find email from contacts
   */
  findEmailFromContacts(query: string): EmailRecipientInfo {
    const contacts: Contact[] = this.userData.profile?.contacts || [];
    
    // First try exact name matching
    let contact = contacts.find((c: Contact) => 
      c.name.toLowerCase() === query.toLowerCase()
    );
    
    if (contact) {
      return {
        email: contact.email,
        name: contact.name,
        found: true
      };
    }
    
    // Then try partial matching - match any part of the name
    contact = contacts.find((c: Contact) => {
      const nameParts = c.name.toLowerCase().split(' ');
      const queryLower = query.toLowerCase();
      return nameParts.some((part: string) => part.includes(queryLower)) || 
             queryLower.includes(nameParts[0]);
    });
    
    if (contact) {
      return {
        email: contact.email,
        name: contact.name,
        found: true
      };
    }
    
    return {
      email: null,
      name: null,
      found: false
    };
  }

  /**
   * Parse recipient address
   */
  parseRecipient(to: string): EmailRecipientInfo {
    // If already in email format, return directly
    if (this.isValidEmail(to)) {
      return {
        email: to,
        name: null,
        found: true
      };
    }
    
    // Otherwise search in contacts
    console.log(`[Email Parse] "${to}" is not in email format, searching contacts...`);
    const result = this.findEmailFromContacts(to);
    if (result.found) {
      console.log(`[Email Parse] ✓ Found contact "${result.name}", email: ${result.email}`);
    } else {
      console.log(`[Email Parse] ✗ Contact "${to}" not found in list, cannot send email`);
    }
    
    return result;
  }

  /**
   * Use large model to polish email content
   */
  async polishEmailContent(subject: string, content: string, emailType: string = "general"): Promise<string> {
    console.log(`[Email Polish] Using large model to polish email content...`);
    
    const typeDescriptions: Record<string, string> = {
      business: "professional business style",
      personal: "friendly personal style",
      notification: "clear notification style",
      apology: "sincere apology style",
      followup: "polite follow-up style",
      general: "standard general style"
    };
    
    const styleGuide = typeDescriptions[emailType] || typeDescriptions.general;
    
    const prompt = `You are a professional email writing assistant. Please polish the email content according to the following requirements:

Original Subject: ${subject}
Original Content:
${content}

Please polish the above email in a ${styleGuide}, with the following requirements:
1. Improve grammar and spelling
2. Enhance clarity and professionalism of expression
3. Keep the original meaning unchanged
4. Optimize the logical structure of the email
5. Adjust tone and expression appropriately

Please return the polished complete email content directly, no explanation needed.`;

    try {
      const response = await this.llm.invoke(prompt);
      // response.content may be string, array or complex object, safely convert to string
      const respContent = (response as unknown as Record<string, unknown>)?.content ?? response;
      let polishedContent: string;
      if (typeof respContent === "string") {
        polishedContent = respContent;
      } else if (Array.isArray(respContent)) {
        // Concatenate array content to string, try to get text field or stringify directly
        polishedContent = respContent
          .map((item: unknown) => {
            if (typeof item === "string") return item;
            if (typeof item === "object" && item !== null) {
              // Common structure may be in .text or .content field
              const itemObj = item as Record<string, unknown>;
              return (itemObj.text as string) ?? (itemObj.content as string) ?? JSON.stringify(item);
            }
            return String(item);
          })
          .join("");
      } else if (typeof respContent === "object" && respContent !== null) {
        const contentObj = respContent as Record<string, unknown>;
        polishedContent = (contentObj.text as string) ?? (contentObj.content as string) ?? JSON.stringify(respContent);
      } else {
        polishedContent = String(respContent);
      }

      console.log(`[Email Polish] ✓ Polish completed`);
      return polishedContent;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`[Email Polish] ⚠ Polish failed, using original content: ${errorMessage}`);
      return content;
    }
  }

  /**
   * Simulate email sending process
   */
  simulateSending(email: string, subject: string, content: string): void {
    const timestamp = new Date().toISOString();
    
    console.log("\n========== Email Sending Process Simulation ==========");
    console.log(`From: ${this.userData.profile.email}`);
    console.log(`To: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(`Content: ${content}`);
    console.log(`Send Time: ${timestamp}`);
    console.log("=====================================================\n");
  }

  /**
   * Execute email sending operation
   */
  async execute(options: EmailSendOptions): Promise<string | EmailSendResult> {
    const { name, subject, content, emailType = "general" } = options;
    console.log(`\n[Email Operation] Starting to send email\n`);
    
    // Step 1: Parse recipient
    const recipientInfo = this.parseRecipient(name);

    if (!recipientInfo.found || !recipientInfo.email) {
      return {
        success: false,
        error: `Unable to parse recipient address: ${name}. Please provide a valid email address or an existing contact name.`,
        recipientEmail: null
      };
    }
    
    // Step 2: Use large model to polish email content
    const polishedContent = await this.polishEmailContent(subject, content, emailType);
    
    // Step 3: Simulate email sending
    this.simulateSending(recipientInfo.email, subject, polishedContent);

    return `Email successfully sent to ${recipientInfo.email}`;
  }
}
