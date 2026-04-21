---
name: audio-transcribe
description: Transcribe audio to text using the OpenAI Whisper API. Use when the user sends a voice message, audio file, or asks to transcribe something.
---

Requires `OPENAI_API_KEY` in the environment.

```bash
curl -s https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@<path>" \
  -F model="whisper-1" \
  -F response_format="text"
```

Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm. Max 25MB.

For files over 25MB, split with ffmpeg first: `ffmpeg -i input.mp3 -f segment -segment_time 600 -c copy chunk_%03d.mp3`

If `OPENAI_API_KEY` is not set, tell the user transcription requires an OpenAI API key and offer to help configure one.
