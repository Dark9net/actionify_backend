/** Zod schemas for /api/v1/users (studio leads: roles and access). */
const { z } = require("zod")
const { SYSTEM_ROLES } = require("../utils/roles")

const slugs = SYSTEM_ROLES.map((r) => r.slug)

/** PATCH /users/:id */
const updateUserSchema = z
  .object({
    role: z.enum(slugs, { error: `Choose one of the roles: ${slugs.join(", ")}.` }).optional(),
    status: z.enum(["active", "disabled"], { error: "Status is active or disabled." }).optional(),
  })
  .refine((d) => d.role !== undefined || d.status !== undefined, { message: "Nothing to change." })

const idParam = z.string().uuid("That isn't a user id.")

module.exports = { updateUserSchema, idParam }
