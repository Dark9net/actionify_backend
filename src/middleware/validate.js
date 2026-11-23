/**
 * Runs a zod schema (validators/login.validator.js) as route middleware.
 *
 *   router.post("/signup", validate(signupSchema), auth.signup)
 *
 * On success req.body is replaced by the parsed values (trimmed, normalised,
 * unknown fields dropped), so controllers never see unchecked input.
 * On failure: 400 { message, code: "VALIDATION", field, errors: { field: message } },
 * with the first problem of each field, and `message` / `field` naming the first one.
 */
const { HttpError } = require("../utils/http-error")

function validate(schema) {
  return (req, _res, next) => {
    const body = req.body
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return next(new HttpError(400, "Send the details as a JSON object.", { code: "VALIDATION" }))
    }

    const result = schema.safeParse(body)
    if (!result.success) return next(failure(result.error))

    req.body = result.data
    next()
  }
}

/**
 * The same for the query string (GET lists): the parsed values go to req.valid, because
 * Express 5 makes req.query read-only.
 *
 *   router.get("/", validateQuery(listSchema), codes.list)   // req.valid.cursor …
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query ?? {})
    if (!result.success) return next(failure(result.error))
    req.valid = result.data
    next()
  }
}

/** 400 with the first problem of each field. */
function failure(error) {
  const errors = {}
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "form"
    errors[field] ??= issue.message
  }
  const [field] = Object.keys(errors)
  return new HttpError(400, errors[field], { code: "VALIDATION", details: { field, errors } })
}

module.exports = { validate, validateQuery }
