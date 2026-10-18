import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const notices = sqliteTable("notices", {
  ownerId: text("owner_id").notNull(),
  id: text("id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  uniqueIndex("notices_owner_fingerprint").on(table.ownerId, table.fingerprint),
]);
