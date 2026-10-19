import { ifItemsDefinition } from './items';
import { z } from 'zod';

import type { NodeDefinition, PortDefinition } from '@catbots/node-kit';

const activationInput: readonly PortDefinition[] = [
  { id: 'activation', dataType: 'activation', cardinality: 'one' },
];
const activationOutput: readonly PortDefinition[] = [
  { id: 'activation', dataType: 'activation', cardinality: 'many' },
];
const conditionInput: readonly PortDefinition[] = [
  { id: 'conditions', dataType: 'condition', cardinality: 'many' },
];
const singleConditionInput: readonly PortDefinition[] = [
  { id: 'condition', dataType: 'condition', cardinality: 'one' },
];
const conditionOutput: readonly PortDefinition[] = [
  { id: 'result', dataType: 'condition', cardinality: 'many' },
];

const referenceSchema = z.object({
  ref: z.string().trim().regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/),
  field: z.string().trim().min(1).optional(),
  maxAgeSeconds: z.number().int().nonnegative().optional(),
}).strict();

const literalSchema = z.object({
  literal: z.union([z.null(), z.boolean(), z.number().finite(), z.string()]),
}).strict();

const operandSchema = z.union([referenceSchema, literalSchema]);

function noRequirements() {
  return { data: [], entitlements: [], permissions: [] } as const;
}

function definition(value: NodeDefinition): NodeDefinition {
  return value;
}

function operandLabel(input: unknown): string {
  const result = operandSchema.safeParse(input);
  if (!result.success) return '?';
  if ('literal' in result.data) return String(result.data.literal);
  return result.data.field ? `${result.data.ref}.${result.data.field}` : result.data.ref;
}

function positionSummary(config: unknown): string {
  const value = config as { state: string; market?: string };
  const labels: Record<string, string> = { flat: 'No open position', open: 'Has an open position', long: 'Has a long position', short: 'Has a short position' };
  return `${labels[value.state] ?? value.state} · ${value.market ?? 'current market'}`;
}

const operatorLabels: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

export const conditionDefinitions: readonly NodeDefinition[] = [
  definition({
    kind: 'condition', type: 'predicate.compare', version: 1,
    configSchema: z.object({
      left: operandSchema,
      operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
      right: operandSchema,
    }).strict(),
    inputs: activationInput, outputs: conditionOutput,
    visualization: {
      title: 'Compare', icon: 'scales',
      summary: (config) => {
        const parsed = z.object({ left: operandSchema, operator: z.string(), right: operandSchema }).safeParse(config);
        return parsed.success
          ? `${operandLabel(parsed.data.left)} ${operatorLabels[parsed.data.operator] ?? parsed.data.operator} ${operandLabel(parsed.data.right)}`
          : 'Compare values';
      },
    },
    requirements: { data: ['dynamic:operand-refs'], entitlements: [], permissions: [] },
  }),
  definition({
    kind: 'condition', type: 'predicate.position_state', version: 1,
    configSchema: z.object({ state: z.enum(['flat', 'open', 'long', 'short']), market: z.string().min(1).optional() }).strict(),
    inputs: activationInput, outputs: conditionOutput,
    visualization: { title: 'Position', icon: 'wallet', summary: positionSummary },
    requirements: { data: ['account.positions'], entitlements: [], permissions: [] },
  }),
  definition({
    kind: 'condition', type: 'predicate.position_state', version: 2,
    configSchema: z.object({ state: z.enum(['flat', 'open', 'long', 'short']) }).strict(),
    inputs: activationInput, outputs: conditionOutput,
    visualization: { title: 'Position', icon: 'wallet', summary: positionSummary },
    requirements: { data: ['account.positions'], entitlements: [], permissions: [] },
  }),
  ...(['all', 'any'] as const).map((combiner) => definition({
    kind: 'condition', type: `combine.${combiner}`, version: 1,
    configSchema: z.object({}).strict(), inputs: conditionInput, outputs: conditionOutput,
    visualization: { title: combiner.toUpperCase(), icon: 'tree', summary: () => combiner === 'all' ? 'Every condition must be true' : 'At least one condition must be true' },
    requirements: noRequirements(),
  })),
  definition({
    kind: 'condition', type: 'combine.not', version: 1,
    configSchema: z.object({}).strict(), inputs: singleConditionInput, outputs: conditionOutput,
    visualization: { title: 'NOT', icon: 'tree', summary: () => 'True when the input is false' },
    requirements: noRequirements(),
  }),
  definition({
    kind: 'condition', type: 'combine.at_least', version: 1,
    configSchema: z.object({ count: z.number().int().positive() }).strict(), inputs: conditionInput, outputs: conditionOutput,
    visualization: { title: 'AT LEAST', icon: 'tree', summary: (config) => `At least ${String((config as { count?: unknown })?.count ?? '?')} conditions must be true` },
    requirements: noRequirements(),
  }),

];

import { definePackage, ready, unavailable } from '@catbots/node-kit';
const conditionNodes = definePackage('@catbots/nodes-condition', [{
  type: 'condition.compare', version: 1, category: 'condition', title: 'Compare values',
  config: z.object({ operator: z.enum(['lt','lte','gt','gte','eq']) }).strict(), inputs: { left:'number', right:'number' }, outputs: { result:'condition' },
  evaluate(input, config) {
    if (Object.values(input).some(value => value.quality !== 'ready')) return { outputs:{result:unavailable('condition','Input unavailable')} };
    const a=input.left.value as number,b=input.right.value as number;
    const result=config.operator==='lt'?a<b:config.operator==='lte'?a<=b:config.operator==='gt'?a>b:config.operator==='gte'?a>=b:a===b;
    return { outputs:{result:ready('condition',result)} };
  },
},{
  type:'condition.combine',version:1,category:'condition',title:'Combine conditions',config:z.object({operator:z.enum(['all','any'])}).strict(),inputs:{left:'condition',right:'condition'},outputs:{result:'condition'},
  evaluate(input,config){const values=Object.values(input);const determining=config.operator==='all'?false:true;
    if(values.some(value=>value.quality==='ready'&&value.value===determining))return {outputs:{result:ready('condition',determining)}};
    if(values.some(value=>value.quality!=='ready'))return {outputs:{result:unavailable('condition','Condition is unknown')}};
    return {outputs:{result:ready('condition',!determining)}};
  },
}]);

export const conditionPackage = definePackage('@catbots/nodes-condition', [...conditionNodes.definitions, {
  type: 'condition.not', version: 1, category: 'condition', title: 'NOT',
  config: z.object({}).strict(), inputs: { condition: 'condition' }, outputs: { result: 'condition' },
  evaluate(input) {
    const value = input.condition;
    return { outputs: { result: value?.quality === 'ready' && typeof value.value === 'boolean'
      ? ready('condition', !value.value) : unavailable('condition', value?.reason ?? 'Condition unavailable') } };
  },
}, {
  type: 'condition.branch', version: 1, category: 'condition', title: 'Branch', activation: 'flow',
  config: z.object({}).strict(), inputs: { flow: 'flow', condition: 'condition' }, outputs: { true: 'flow', false: 'flow' },
  evaluate(input) {
    if (input.condition.quality !== 'ready') return { outputs: { true: unavailable('flow', 'Condition unavailable'), false: unavailable('flow', 'Condition unavailable') } };
    return { outputs: { true: ready('flow', input.condition.value === true), false: ready('flow', input.condition.value === false) } };
  },
}, ifItemsDefinition]);
