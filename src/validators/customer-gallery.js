/**
 * Zod schemas for /api/v1/customer-gallery: the client's gallery page (Frontend/src/pages/authpanel/
 * Dashboard.jsx). There is nothing to choose but the next page of photographs: which gallery is shown
 * comes only from the browser's gallery session (the code it opened), never from the request.
 */
const { z } = require("zod")
const { cursor, encodeCursor } = require("./media")

/** Photographs and videos per page; the page asks for the next until it has them all. */
const PAGE_SIZE = 200

const itemsQuery = z.object({
  cursor: cursor.optional(),
})

module.exports = { itemsQuery, encodeCursor, PAGE_SIZE }
