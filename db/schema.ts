import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  username: text("username").primaryKey(),
  rating: integer("rating").notNull().default(1200),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  games: integer("games").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  whiteUsername: text("white_username").notNull(),
  blackUsername: text("black_username").notNull(),
  result: text("result").notNull(),
  pgn: text("pgn").notNull(),
  createdAt: integer("created_at").notNull(),
});
