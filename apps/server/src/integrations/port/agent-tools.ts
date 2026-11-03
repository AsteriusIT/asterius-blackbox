import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../../config.js';
import { port } from './client.js';
import { BP } from './mapping.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `ERROR: ${(e as Error).message}` }], isError: true });

/** What the platform already guarantees, so the agent focuses on the rules it can influence. */
const PLATFORM_HANDLED = /repository linked|has team|approver count/i;

export const portAgentToolsEnabled = () => port.enabled && config.PORT_AGENT_CONTEXT;

/** Read-only Port context for the planner. Credentials stay in the platform process. */
export function portAgentTools() {
  return [
    tool(
      'port_production_standards',
      "Read the organization's production standards from Port (scorecards on the `service` blueprint: rules per level Bronze/Silver/Gold). Use them as acceptance criteria when planning, so the application scores well in the developer portal from day one.",
      {},
      async () => {
        try {
          const cards = await port.scorecards(BP.service);
          const lines: string[] = [];
          for (const c of cards) {
            if (!c.rules?.length) continue;
            lines.push(`## ${c.title}`);
            const order = ['Bronze', 'Silver', 'Gold'];
            for (const r of [...c.rules].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))) {
              const handled = PLATFORM_HANDLED.test(r.title) ? ' _(handled by the Blackbox platform)_' : '';
              lines.push(`- [${r.level}] ${r.title}${r.description ? ` — ${r.description}` : ''}${handled}`);
            }
          }
          return text(
            lines.length
              ? `${lines.join('\n')}\n\nNotes: rules about PR cycle time, throughput and build failure rates are measured over time from Azure DevOps — keep PRs small and the CI pipeline green. "Has CI builds" means an azure-pipelines.yml that runs (then call enable_ci). "Has README" means a useful README.md.`
              : 'No scorecard rules are defined on services in Port.',
          );
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool(
      'port_find_services',
      'Search the software catalog in Port for existing services and Blackbox applications by name, to avoid duplicating something that exists and to discover APIs you could reuse. Read-only.',
      { query: z.string().min(2).describe('A single word works best, e.g. "invoice"') },
      async ({ query }) => {
        try {
          const rules = [
            {
              combinator: 'or',
              rules: [
                { property: '$title', operator: 'contains', value: query },
                { property: '$identifier', operator: 'contains', value: query },
              ],
            },
          ];
          const [services, apps] = await Promise.all([port.searchEntities(BP.service, rules), port.searchEntities(BP.app, rules)]);
          const fmt = (e: { identifier: string; title?: string; team?: string[]; properties?: Record<string, unknown> }) =>
            `- ${e.title ?? e.identifier} (${e.identifier})${e.team?.length ? ` · team: ${e.team.join(', ')}` : ''}${e.properties?.description ? ` — ${String(e.properties.description).slice(0, 160)}` : ''}`;
          return text(
            [
              `Services matching "${query}": ${services.length ? '\n' + services.slice(0, 15).map(fmt).join('\n') : 'none'}`,
              `Blackbox applications matching "${query}": ${apps.length ? '\n' + apps.slice(0, 15).map(fmt).join('\n') : 'none'}`,
            ].join('\n\n'),
          );
        } catch (e) {
          return fail(e);
        }
      },
    ),
  ];
}
