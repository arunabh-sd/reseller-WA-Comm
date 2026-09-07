// Maps broadcast category names → actual clean_product_type slugs from Metabase
// Slot category → sub-categories the slot can draw from
export const CATEGORY_TYPES = {
  kurti: [
    "womens_clothing__womens_ethnic_wear__kurta_set",
    "womens_clothing__womens_ethnic_wear__kurti",
  ],
  saree: [
    "womens_clothing__womens_ethnic_wear__saree",
  ],
  western: [
    "womens_clothing__womens_western_wear__coord_set",
    "womens_clothing__womens_western_wear__top",
    "womens_clothing__womens_western_wear__dress",
    "womens_clothing__womens_western_wear__gown",
    "womens_clothing__womens_western_wear__palazzo",
    "womens_clothing__womens_western_wear__shirt",
  ],
  jewellery: [
    "womens_accessories__womens_fashion_jewellery__bangle_bracelet",
    "womens_accessories__womens_fashion_jewellery__necklace_set",
    "womens_accessories__womens_fashion_jewellery__necklace",
    "womens_accessories__womens_fashion_jewellery__jewellery_set",
    "womens_accessories__womens_fashion_jewellery__earring",
    "womens_accessories__womens_fashion_jewellery__ring",
    "womens_accessories__womens_fashion_jewellery__anklet",
    "womens_accessories__womens_fashion_jewellery__chain",
    "womens_accessories__womens_fashion_jewellery__pendant",
    "womens_accessories__womens_fashion_jewellery__pendant_set",
    "womens_accessories__womens_fashion_jewellery__mangalsutra",
    "womens_accessories__womens_fashion_jewellery__mangalsutra_set",
    "womens_accessories__womens_fashion_jewellery__kamarband",
    "womens_accessories__womens_fashion_jewellery__hair_accessory",
    "womens_accessories__womens_fashion_jewellery__bridal_set",
  ],
  bags: [
    "womens_accessories__womens_bags__handbag",
    "womens_accessories__womens_bags__sling_bag",
    "womens_accessories__womens_bags__tote_bag",
  ],
};

// Human-readable label for each sub-category (used in WA message header)
export const SUBCATEGORY_LABELS = {
  womens_clothing__womens_ethnic_wear__kurta_set: "Kurta Sets",
  womens_clothing__womens_ethnic_wear__kurti: "Kurtis",
  womens_clothing__womens_ethnic_wear__saree: "Sarees",
  womens_clothing__womens_western_wear__coord_set: "Co-ord Sets",
  womens_clothing__womens_western_wear__top: "Tops",
  womens_clothing__womens_western_wear__dress: "Dresses",
  womens_clothing__womens_western_wear__gown: "Gowns",
  womens_clothing__womens_western_wear__palazzo: "Palazzo Sets",
  womens_clothing__womens_western_wear__shirt: "Shirts",
  womens_accessories__womens_fashion_jewellery__bangle_bracelet: "Bangles & Bracelets",
  womens_accessories__womens_fashion_jewellery__necklace_set: "Necklace Sets",
  womens_accessories__womens_fashion_jewellery__necklace: "Necklaces",
  womens_accessories__womens_fashion_jewellery__jewellery_set: "Jewellery Sets",
  womens_accessories__womens_fashion_jewellery__earring: "Earrings",
  womens_accessories__womens_fashion_jewellery__ring: "Rings",
  womens_accessories__womens_fashion_jewellery__anklet: "Anklets",
  womens_accessories__womens_fashion_jewellery__chain: "Chains",
  womens_accessories__womens_fashion_jewellery__mangalsutra: "Mangalsutras",
  womens_accessories__womens_fashion_jewellery__mangalsutra_set: "Mangalsutra Sets",
  womens_accessories__womens_bags__handbag: "Handbags",
  womens_accessories__womens_bags__sling_bag: "Sling Bags",
  womens_accessories__womens_bags__tote_bag: "Tote Bags",
};

// All product types that are active in the catalogue (quick lookup set)
export const ALL_ACTIVE_TYPES = new Set(Object.values(CATEGORY_TYPES).flat());
