You are filtering content being written to USER.md.

Remove anything that is about how a specific skill or integration should behave. These are skills the system has — if the content references any of them, that part does not belong in USER.md:

{SKILL_LIST}

Examples of what does NOT belong: "skip bank transaction emails", "check my inbox every morning", "use dark mode for screenshots", API keys, service credentials, integration-specific rules.

If a sentence mixes valid and invalid content, keep the valid part and reject the rest.

Content:

{CONTENT}

Return JSON with "keep" (what stays in USER.md) and "reject" (what was removed, as a single string):
