import {
	sqliteTable,
	text,
	integer,
	real,
	primaryKey,
} from "drizzle-orm/sqlite-core";

// Reference data is rows, never code: adding a storefront is an INSERT.

export const storefront = sqliteTable("storefront", {
	code: text("code").primaryKey(), // 'fr', 'be', 'ch', ...
	name: text("name").notNull(),
	// Numeric storefront id used by the X-Apple-Store-Front header on the
	// search-hints endpoint. NULL where not yet verified.
	appleStorefrontId: integer("apple_storefront_id"),
	// Market importance for scheduler priority; user-editable, seedable from
	// App Store Connect revenue once available.
	weight: real("weight").notNull().default(1),
	active: integer("active").notNull().default(1),
});

export const locale = sqliteTable("locale", {
	code: text("code").primaryKey(), // App Store Connect localization codes: 'fr-FR', 'en-GB', ...
	language: text("language").notNull(), // 'fr', 'en': the language dimension
});

// Which locales each storefront's search index covers (Apple's
// cross-localization
// table from the ASC "App Store localizations" reference). A keyword is
// tracked
// against a (storefront, locale) pair, never a storefront alone.
export const storefrontLocale = sqliteTable(
	"storefront_locale",
	{
		isDefault: integer("is_default").notNull().default(0),
		localeCode: text("locale_code")
			.notNull()
			.references(() => locale.code),
		storefrontCode: text("storefront_code")
			.notNull()
			.references(() => storefront.code),
	},
	(t) => [primaryKey({ columns: [t.storefrontCode, t.localeCode] })]
);

export const genre = sqliteTable("genre", {
	id: integer("id").primaryKey(), // iTunes genre id: 7019 Word, 7012 Puzzle, ...
	name: text("name").notNull(),
	parentId: integer("parent_id"),
});
