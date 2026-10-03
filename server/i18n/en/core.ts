import type fr from '../fr/core';

export default {
  http: {
    host: 'Host not allowed',
    badRequest: 'Invalid request',
    crossSite: 'Cross-site request refused',
    token: 'Missing or invalid Cadence token',
    origin: 'Origin refused',
    mcpToken: 'Missing or invalid MCP token',
    mcpError: (error: string) => `MCP error: ${error}`,
    mcpLog: '[cadence] MCP error:',
    notFound: 'Not found',
    editorUnavailable: (error: string) => `Editor unavailable: ${error}`,
  },
  settings: {
    model: (value: unknown) => `Invalid model: ${value}`,
    effort: (value: unknown) => `Invalid effort level: ${value}`,
    language: (value: unknown) => `Invalid language: ${value}`,
    agent: (value: unknown) => `Invalid agent: ${value}`,
  },
  usage: {
    notSaved: '[cadence] Usage not recorded:',
  },
  windows: 'Cadence runs on macOS and Linux. On Windows, run it in WSL 2.',
} satisfies typeof fr;
