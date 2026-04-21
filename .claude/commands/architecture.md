Trace the complete message flow through the system by reading the current code. Follow every entry point (user messages, schedules, reminders, webhooks, agent completions) through to final delivery. Cover how events are queued, how the activation loop processes them, what happens during LLM calls, where messages are stored, how they reach users on every channel, what stewards run at each stage, how agents are spawned and complete, and how errors are handled.

Read whatever source files you need to build an accurate trace. Start from the entry point, follow the activation loop, trace through the tool loop, agent lifecycle, and delivery paths. Capture exceptions, special cases, and different flows for different event types.

Output the result directly in this conversation using ASCII flow diagrams, tables, and concise text. Do NOT write to any files. The goal is a snapshot someone can read in 5 minutes and understand how any message moves through the system.

Do NOT include line numbers. DO include file paths and function names.
