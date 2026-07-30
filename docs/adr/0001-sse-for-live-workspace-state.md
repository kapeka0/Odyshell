# Use SSE for live workspace state

Odyshell uses authenticated Server-Sent Events to publish machine presence and active connection
changes to the Web Control Plane in real time. SSE provides the one-way delivery the UI needs with
automatic reconnection and substantially less protocol complexity than another WebSocket channel;
slow polling remains a fallback, and distributed fan-out infrastructure is deferred until scale
requires it.
