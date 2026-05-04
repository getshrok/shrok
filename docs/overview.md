# Overview

Shrok can be powerful once you get to know the pieces, but agent-driven stuff is deceptively complex, and can easily become chaotic, so here's what you need to know

## 💬 Talking to Shrok

No matter where you talk to it from, whether it's the built-in web dashboard (http://localhost:8888) or chat apps like Discord and WhatsApp, you are talking to the same Shrok.

Anytime you ask Shrok to do something that requires real work, it creates a background agent to do it. So it is always available to talk and take on more requests. It will create more agents as needed to take on multiple tasks at once.

Communication is bi-directional with agents. When an agent has a question mid-task, it gets passed through to you while it waits for the answer. And when you want to check the status of an agent or give them additional instructions, just tell Shrok and it will relay the message.

## ⚡ Skills

Skills teach Shrok new capabilities. They come in the form of text files (SKILL.md). Sometimes they include extra pieces like helper scripts, and many of them store persistent info in MEMORY.md files (like API keys, things agents have learned about using the skill over time, etc)

Shrok comes with many skills for basic functionality, and more skills can be found at [getshrok/skills](https://github.com/getshrok/skills). You can ask Shrok to install a skill from that repo explicitly, or ask it to make you one for whatever capability you want to add.

Skills can also be manually placed in the ~/.shrok/workspace/skills folder. In that folder, there is also a "skills" skill which lists best practices for creating skills.

**⚠️ Skills can come from anywhere, but be careful to only install skills from sources you trust. Many publicly available on the internet have been found to be malicious, and depending on where Shrok is installed, these malicious skills could easily gain access to your sensitive data. ⚠️**

## ☑️ Tasks

Tasks are the main way that Shrok acts on its own. They are essentially just messages that you want to send to Shrok automatically at a future time, instructing it to do something. You might tell it to check your email once a day, or to check to make sure your flight hasn't been delayed as a one time task.

Shrok decides if a scheduled task should run as planned, so for the email example you could say something like "Don't bother checking on weekends" when you schedule that task. Or for the flight example, it might decide not to bother checking if you had just mentioned the day before that the trip was cancelled.

Task templates can be found at [getshrok/tasks](https://github.com/getshrok/tasks).

## 🧠 Memory

Shrok remembers all past conversations you've had with it, and passively pulls them from memory as needed when it responds. 

For details on the inner workings of the memory system, check out [getshrok/infinite-context-window](https://github.com/getshrok/infinite-context-window).

## 🧑 Identity

Shrok also saves info about you and the people in your life as those things come up in conversation. The better it knows you, the more helpful it can be. It saves these to its SOUL.md and USER.md files, so you can tell it explicitly to write something to them if you want to make sure it is saved. Unlike memories, these files are visible to Shrok at all times.

## 💲 LLM Providers and Cost

Shrok uses your own API keys to function. Anthropic, OpenAI, and Google Gemini are supported, and you can add keys for multiple providers and set a priority order so Shrok falls back automatically.

You can keep an eye on your spending in the dashboard's Usage area and set thresholds that alert you or stop further spending when you hit them.

**⚠️ Beware! I tried to head off unnecessary spending in as many places as I could, but personal agents are very open-ended by nature. Something as simple as scheduling a task to run too often can result in a way bigger API bill than expected. All the model providers have hard limits you can set in their API consoles (usually in the billing section), so you can use that as another line of defense. ⚠️**
