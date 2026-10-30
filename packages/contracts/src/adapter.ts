import { z } from 'zod';
import { Digest, Domain, Id, SchemaVersion } from './common.js';
import { DEFAULT_POLICY } from './policy.js';

export const ObservationKey = z.enum([
  'times',
  'temperature',
  'positions',
  'velocities',
  'masses',
  'central_mu',
  'gravity_constant',
  'thermal_weights',
  'source_power',
  'outward_power',
]);
const Identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)
  .refine((value) => !value.startsWith('__'));
export const ObservationMapping = z
  .strictObject({
    key: ObservationKey,
    root: Identifier,
    steps: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('key'),
            key: z.string().min(1).max(200),
          }),
          z.strictObject({
            kind: z.literal('index'),
            index: z.number().int().nonnegative().max(1000000),
          }),
        ]),
      )
      .max(8),
    expectedShape: z.array(z.number().int().positive().max(65536)).max(4),
    axisOrder: z.array(z.number().int().nonnegative().max(3)).max(4),
    declaredUnit: z.string().min(1).max(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.axisOrder.length !== value.expectedShape.length ||
      [...value.axisOrder]
        .sort((a, b) => a - b)
        .some((axis, index) => axis !== index)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Axis order must be an exact dimension permutation',
      });
  });
export const AdapterProposal = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    contextDigest: Digest,
    sourceArtifactId: Id,
    sourceDigest: Digest,
    domain: Domain,
    handler: z.literal('script_globals_v1'),
    mappings: z.array(ObservationMapping).min(2).max(10),
  })
  .superRefine((value, ctx) => {
    const keys = value.mappings.map((mapping) => mapping.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate observation key' });
    const required =
      value.domain === 'heat_diffusion'
        ? ['times', 'temperature']
        : ['times', 'positions', 'velocities'];
    const allowed =
      value.domain === 'heat_diffusion'
        ? [
            'times',
            'temperature',
            'thermal_weights',
            'source_power',
            'outward_power',
          ]
        : [
            'times',
            'positions',
            'velocities',
            'masses',
            'central_mu',
            'gravity_constant',
          ];
    if (
      required.some((key) => !keys.includes(key as (typeof keys)[number])) ||
      keys.some((key) => !allowed.includes(key))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Observation set does not match selected domain',
      });
    const shape = (key: string) =>
      value.mappings.find((mapping) => mapping.key === key)?.expectedShape;
    const times = shape('times');
    const observed = shape(
      value.domain === 'heat_diffusion' ? 'temperature' : 'positions',
    );
    const invalid = () =>
      ctx.addIssue({
        code: 'custom',
        message:
          'Canonical observation shapes are inconsistent or exceed domain limits',
      });
    if (!times || times.length !== 1 || !observed || observed[0] !== times[0])
      invalid();
    else if (value.domain === 'heat_diffusion') {
      if (
        ![2, 3].includes(observed.length) ||
        observed.slice(1).reduce((a, b) => a * b, 1) > DEFAULT_POLICY.heatCells
      )
        invalid();
      const weights = shape('thermal_weights');
      if (
        weights &&
        JSON.stringify(weights) !== JSON.stringify(observed.slice(1))
      )
        invalid();
      for (const key of ['source_power', 'outward_power']) {
        const power = shape(key);
        if (power && JSON.stringify(power) !== JSON.stringify(times)) invalid();
      }
    } else {
      if (
        observed.length !== 3 ||
        observed[1]! > DEFAULT_POLICY.orbitalBodies ||
        ![2, 3].includes(observed[2]!) ||
        JSON.stringify(shape('velocities')) !== JSON.stringify(observed)
      )
        invalid();
      const masses = shape('masses');
      if (masses && (masses.length !== 1 || masses[0] !== observed[1]))
        invalid();
      for (const key of ['central_mu', 'gravity_constant']) {
        const parameter = shape(key);
        if (parameter && parameter.length !== 0) invalid();
      }
    }
  });
export type AdapterProposal = z.infer<typeof AdapterProposal>;
