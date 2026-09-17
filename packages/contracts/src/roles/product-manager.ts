import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

export const ProductDefinitionSchema = BaseOutputSchema.extend({
  outcome: z.enum(["PRODUCT_DEFINITION", "NEEDS_INPUT"]),
  goal: z.string().min(1).optional(),
  userBehavior: z.array(z.string().min(1)).optional(),
  scope: z.array(z.string().min(1)).optional(),
  nonGoals: z.array(z.string().min(1)).optional(),
  requirements: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
}).strict();

export type ProductDefinition = z.infer<typeof ProductDefinitionSchema>;
