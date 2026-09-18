// 22 slots/day — every 30 min, 9:00am–7:30pm IST (11 hours × 2 slots)
// Distribution: Mangalsutra ×3, Necklace ×3, Kurti ×3, Earring ×2, Saree ×2,
//               Bangle ×2, Handbag ×2, Coord ×2, Slipper ×2, Watch ×1
export const DAILY_SLOTS = [
  { hour: 9,  minute: 0,  category: "mangalsutra" },
  { hour: 9,  minute: 30, category: "necklace"    },
  { hour: 10, minute: 0,  category: "kurti"       },
  { hour: 10, minute: 30, category: "earring"     },
  { hour: 11, minute: 0,  category: "saree"       },
  { hour: 11, minute: 30, category: "bangle"      },
  { hour: 12, minute: 0,  category: "mangalsutra" },
  { hour: 12, minute: 30, category: "handbag"     },
  { hour: 13, minute: 0,  category: "necklace"    },
  { hour: 13, minute: 30, category: "coord"       },
  { hour: 14, minute: 0,  category: "kurti"       },
  { hour: 14, minute: 30, category: "earring"     },
  { hour: 15, minute: 0,  category: "bangle"      },
  { hour: 15, minute: 30, category: "mangalsutra" },
  { hour: 16, minute: 0,  category: "saree"       },
  { hour: 16, minute: 30, category: "necklace"    },
  { hour: 17, minute: 0,  category: "kurti"       },
  { hour: 17, minute: 30, category: "coord"       },
  { hour: 18, minute: 0,  category: "handbag"     },
  { hour: 18, minute: 30, category: "slipper"     },
  { hour: 19, minute: 0,  category: "watch"       },
  { hour: 19, minute: 30, category: "slipper"     },
];

export const PRODUCTS_PER_SHARE = 4;
export const MIN_L30D_ORDERS    = 0;
