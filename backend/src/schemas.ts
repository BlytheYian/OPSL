import { z } from "zod";
export const AuthRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6),
});
export type AuthRequest = z.infer<typeof AuthRequestSchema>;

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const CreateInstanceRequestSchema = z.object({
  modelId: z.string().min(1),
  label: z.string().min(1),
});
export type CreateInstanceRequest = z.infer<typeof CreateInstanceRequestSchema>;

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "顏色要是 #rrggbb 格式");

export const UpdateInstanceRequestSchema = z.object({
  label: z.string().min(1).optional(),
  hidden: z.boolean().optional(),
  position: Vec3Schema.optional(),
  rotation: Vec3Schema.optional(),
  scale: Vec3Schema.optional(),
  color: ColorSchema.nullable().optional(),
});
export type UpdateInstanceRequest = z.infer<typeof UpdateInstanceRequestSchema>;

export const VisibleInstanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  x: z.number(),
  y: z.number(),
  modelId: z.string(),
  color: z.string().nullable(),
  distance: z.number(),
  worldPos: Vec3Schema.nullable().optional(),
});
export const PreviousEditContextSchema = z
  .object({
    command: z.string(),
    instances: z.array(z.object({ id: z.string(), label: z.string() })),
  })
  .nullable()
  .optional();

export const CameraAxesSchema = z
  .object({
    right: Vec3Schema,
    up: Vec3Schema,
    forward: Vec3Schema,
  })
  .nullable()
  .optional();

export const EditCommandRequestSchema = z.object({
  command: z.string().min(1).max(500),
  image: z.string().min(1),
  instances: z.array(VisibleInstanceSchema).min(1),
  previousContext: PreviousEditContextSchema,
  cameraAxes: CameraAxesSchema,
});
export type EditCommandRequest = z.infer<typeof EditCommandRequestSchema>;

export const SplitCommandItemSchema = z.object({
  text: z.string().min(1),
  referencesPrevious: z.boolean(),
});
export const SplitCommandSchema = z.object({
  commands: z.array(SplitCommandItemSchema).min(1),
});
export type SplitCommand = z.infer<typeof SplitCommandSchema>;

export const VisionBoxSchema = z.object({
  box_2d: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  label: z.string().nullable().optional(),
});
export const VisionMatchSchema = z.array(VisionBoxSchema);
export type VisionMatch = z.infer<typeof VisionMatchSchema>;

export const LLMEditDeltaSchema = z.object({
  action: z.enum(["adjust", "hide", "delete", "replace", "place"]).default("adjust"),
  positionDelta: Vec3Schema.nullable().optional(),
  rotationDelta: Vec3Schema.nullable().optional(),
  scaleMultiplier: Vec3Schema.nullable().optional(),
  color: ColorSchema.nullable().optional(),
  resetPosition: z.boolean().optional(),
  resetRotation: z.boolean().optional(),
  resetScale: z.boolean().optional(),
  resetColor: z.boolean().optional(),
  replacementQuery: z.string().nullable().optional(),
  placementQuery: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
});
export type LLMEditDelta = z.infer<typeof LLMEditDeltaSchema>;

export const CreateVersionRequestSchema = z.object({
  sourceCommands: z.array(z.string()).optional(),
});
export type CreateVersionRequest = z.infer<typeof CreateVersionRequestSchema>;

export interface ResolvedEditAction {
  instanceIds: string[];
  action: "adjust" | "hide" | "delete" | "replace" | "place";
  positionDelta: [number, number, number] | null;
  rotationDelta: [number, number, number] | null;
  scaleMultiplier: [number, number, number] | null;
  color: string | null;
  resetPosition: boolean;
  resetRotation: boolean;
  resetScale: boolean;
  resetColor: boolean;
  replacementQuery: string | null;
  placementQuery: string | null;
  reasoning: string | null;
}
