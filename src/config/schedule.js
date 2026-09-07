// Daily broadcast schedule — 11 slots, 9am–7pm IST
// Each slot: { hour, category, aovBucket }
// aovBucket: 'low' (≤500), 'mid' (501-1500), 'high' (>1500), 'any'
// Rotating across price bands ensures healthy AOV variety across the day

export const DAILY_SLOTS = [
  { hour: 9,  category: "kurti",    aovBucket: "mid"  },
  { hour: 10, category: "jewellery",aovBucket: "low"  },
  { hour: 11, category: "saree",    aovBucket: "high" },
  { hour: 12, category: "kurti",    aovBucket: "low"  },
  { hour: 13, category: "western",  aovBucket: "mid"  },
  { hour: 14, category: "jewellery",aovBucket: "mid"  },
  { hour: 15, category: "kurti",    aovBucket: "high" },
  { hour: 16, category: "saree",    aovBucket: "mid"  },
  { hour: 17, category: "western",  aovBucket: "low"  },
  { hour: 18, category: "jewellery",aovBucket: "high" },
  { hour: 19, category: "bags",     aovBucket: "any"  },
];

// Price thresholds (reseller_selling_price in ₹)
export const AOV_BUCKETS = {
  low:  { min: 0,    max: 500  },
  mid:  { min: 501,  max: 1500 },
  high: { min: 1501, max: Infinity },
  any:  { min: 0,    max: Infinity },
};

// Products per share (how many products in one WA message)
export const PRODUCTS_PER_SHARE = 4;

// Bestseller threshold: min seller orders in last 30 days
export const MIN_L30D_ORDERS = 10;
