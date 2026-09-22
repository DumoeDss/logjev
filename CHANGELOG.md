# Changelog

## 0.1.1 — 2026-09-22

- Report a missing configured provider key as an actionable 503 before making upstream requests; unused providers and keyless local servers remain usable.
- Clarify that each selected configuration loads its adjacent `.env`; using Python credentials requires explicitly selecting that configuration or configuring the Node environment.
- Update shared demos to show complete bookmark errors, count only successful classifications, and avoid showing failed requests as 0% confidence.

## 0.1.0 — 2026-09-22

- Initial public Node.js / TypeScript release, published as `@atelierai/logjev`.
- Jev-compatible choice, score, and noul decisions from first-token logprobs.
- Text, image, and audio input; multiple hosted or local providers; official Jev passthrough.
- Portable Fetch handler, Node HTTP server, CLI, authentication, retries, and concurrency limits.
- Three bundled browser demos, bilingual documentation, a 2048 recording, and installable agent skills.
- Audio classification verified with NVIDIA Nemotron Omni; MiMo and Muse probability limitations documented.
