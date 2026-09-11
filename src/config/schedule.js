// 23 slots/day — every 30 min, 9:00am–8:00pm IST
// Distribution: Kurti ×8, Jewellery ×6, Saree ×4, Western ×3, Bags ×2
export const DAILY_SLOTS = [
  { hour: 9,  minute: 0,  category: "kurti",     aovBucket: "mid"  },
  { hour: 9,  minute: 30, category: "jewellery",  aovBucket: "low"  },
  { hour: 10, minute: 0,  category: "kurti",     aovBucket: "high" },
  { hour: 10, minute: 30, category: "saree",      aovBucket: "mid"  },
  { hour: 11, minute: 0,  category: "kurti",     aovBucket: "low"  },
  { hour: 11, minute: 30, category: "western",    aovBucket: "mid"  },
  { hour: 12, minute: 0,  category: "jewellery",  aovBucket: "mid"  },
  { hour: 12, minute: 30, category: "kurti",     aovBucket: "mid"  },
  { hour: 13, minute: 0,  category: "saree",      aovBucket: "high" },
  { hour: 13, minute: 30, category: "jewellery",  aovBucket: "high" },
  { hour: 14, minute: 0,  category: "kurti",     aovBucket: "low"  },
  { hour: 14, minute: 30, category: "bags",       aovBucket: "any"  },
  { hour: 15, minute: 0,  category: "jewellery",  aovBucket: "low"  },
  { hour: 15, minute: 30, category: "kurti",     aovBucket: "high" },
  { hour: 16, minute: 0,  category: "western",    aovBucket: "low"  },
  { hour: 16, minute: 30, category: "saree",      aovBucket: "mid"  },
  { hour: 17, minute: 0,  category: "kurti",     aovBucket: "mid"  },
  { hour: 17, minute: 30, category: "jewellery",  aovBucket: "mid"  },
  { hour: 18, minute: 0,  category: "kurti",     aovBucket: "low"  },
  { hour: 18, minute: 30, category: "saree",      aovBucket: "high" },
  { hour: 19, minute: 0,  category: "jewellery",  aovBucket: "high" },
  { hour: 19, minute: 30, category: "western",    aovBucket: "mid"  },
  { hour: 20, minute: 0,  category: "bags",       aovBucket: "any"  },
];

export const AOV_BUCKETS = {
  low:  { min: 0,    max: 500      },
  mid:  { min: 501,  max: 1500     },
  high: { min: 1501, max: Infinity },
  any:  { min: 0,    max: Infinity },
};

export const PRODUCTS_PER_SHARE = 4;
export const MIN_L30D_ORDERS    = 5;
