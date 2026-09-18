// Maps broadcast category names → actual clean_product_type slugs from Metabase
// Slot category → sub-categories the slot can draw from
export const CATEGORY_TYPES = {
  // ── Ethnic wear ─────────────────────────────────────────────────────────────
  kurti: [
    "womens_clothing__womens_ethnic_wear__kurta_set",
    "womens_clothing__womens_ethnic_wear__kurti",
  ],
  saree: [
    "womens_clothing__womens_ethnic_wear__saree",
  ],

  // ── Western wear ─────────────────────────────────────────────────────────────
  coord: [
    "womens_clothing__womens_western_wear__coord_set",
  ],

  // ── Jewellery — split into 4 specific slot types ──────────────────────────
  mangalsutra: [
    "womens_accessories__womens_fashion_jewellery__mangalsutra",
    "womens_accessories__womens_fashion_jewellery__mangalsutra_set",
  ],
  necklace: [
    "womens_accessories__womens_fashion_jewellery__necklace_set",
    "womens_accessories__womens_fashion_jewellery__necklace",
    "womens_accessories__womens_fashion_jewellery__jewellery_set",
    "womens_accessories__womens_fashion_jewellery__pendant_set",
    "womens_accessories__womens_fashion_jewellery__pendant",
    "womens_accessories__womens_fashion_jewellery__chain",
    "womens_accessories__womens_fashion_jewellery__bridal_set",
  ],
  bangle: [
    "womens_accessories__womens_fashion_jewellery__bangle_bracelet",
    "womens_accessories__womens_fashion_jewellery__ring",
    "womens_accessories__womens_fashion_jewellery__anklet",
    "womens_accessories__womens_fashion_jewellery__kamarband",
    "womens_accessories__womens_fashion_jewellery__hair_accessory",
  ],
  earring: [
    "womens_accessories__womens_fashion_jewellery__earring",
  ],

  // ── Bags ─────────────────────────────────────────────────────────────────────
  handbag: [
    "womens_accessories__womens_bags__handbag",
    "womens_accessories__womens_bags__sling_bag",
    "womens_accessories__womens_bags__tote_bag",
  ],

  // ── Watches — verify slug from Metabase card 13784 if no products appear ──
  watch: [
    "womens_accessories__watch",
    "accessories__watch",
  ],

  // ── Slippers — verify slug from Metabase card 13784 if no products appear ─
  slipper: [
    "womens_footwear__slipper",
    "footwear__slipper",
    "womens_footwear__footwear__slipper",
  ],
};

// Human-readable label for each sub-category (used in WA message header)
export const SUBCATEGORY_LABELS = {
  // Ethnic
  womens_clothing__womens_ethnic_wear__kurta_set:            "Kurta Sets",
  womens_clothing__womens_ethnic_wear__kurti:                "Kurtis",
  womens_clothing__womens_ethnic_wear__saree:                "Sarees",

  // Western
  womens_clothing__womens_western_wear__coord_set:           "Co-ord Sets",
  womens_clothing__womens_western_wear__top:                 "Tops",
  womens_clothing__womens_western_wear__dress:               "Dresses",
  womens_clothing__womens_western_wear__gown:                "Gowns",
  womens_clothing__womens_western_wear__palazzo:             "Palazzo Sets",
  womens_clothing__womens_western_wear__shirt:               "Shirts",

  // Jewellery
  womens_accessories__womens_fashion_jewellery__bangle_bracelet: "Bangles & Bracelets",
  womens_accessories__womens_fashion_jewellery__necklace_set:    "Necklace Sets",
  womens_accessories__womens_fashion_jewellery__necklace:        "Necklaces",
  womens_accessories__womens_fashion_jewellery__jewellery_set:   "Jewellery Sets",
  womens_accessories__womens_fashion_jewellery__earring:         "Earrings",
  womens_accessories__womens_fashion_jewellery__ring:            "Rings",
  womens_accessories__womens_fashion_jewellery__anklet:          "Anklets",
  womens_accessories__womens_fashion_jewellery__chain:           "Chains",
  womens_accessories__womens_fashion_jewellery__mangalsutra:     "Mangalsutras",
  womens_accessories__womens_fashion_jewellery__mangalsutra_set: "Mangalsutra Sets",
  womens_accessories__womens_fashion_jewellery__pendant:         "Pendants",
  womens_accessories__womens_fashion_jewellery__pendant_set:     "Pendant Sets",
  womens_accessories__womens_fashion_jewellery__bridal_set:      "Bridal Sets",
  womens_accessories__womens_fashion_jewellery__kamarband:       "Kamarbands",
  womens_accessories__womens_fashion_jewellery__hair_accessory:  "Hair Accessories",

  // Bags
  womens_accessories__womens_bags__handbag:   "Handbags",
  womens_accessories__womens_bags__sling_bag: "Sling Bags",
  womens_accessories__womens_bags__tote_bag:  "Tote Bags",

  // Watches & Footwear
  womens_accessories__watch:                 "Watches",
  accessories__watch:                        "Watches",
  womens_footwear__slipper:                  "Slippers",
  footwear__slipper:                         "Slippers",
  womens_footwear__footwear__slipper:        "Slippers",
};

// Slot-level labels — used when no sub-category match is found in SUBCATEGORY_LABELS
export const SLOT_LABELS = {
  mangalsutra: "Mangalsutras",
  necklace:    "Necklaces",
  bangle:      "Bangles & Rings",
  earring:     "Earrings",
  coord:       "Co-ord Sets",
  handbag:     "Handbags",
  kurti:       "Kurtis",
  saree:       "Sarees",
  watch:       "Watches",
  slipper:     "Slippers",
};

// All product types that are active in the catalogue (quick lookup set)
export const ALL_ACTIVE_TYPES = new Set(Object.values(CATEGORY_TYPES).flat());
