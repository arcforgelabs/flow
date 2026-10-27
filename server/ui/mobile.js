// Phone rules for every shared component. The source is each card's
// mobile.json (design-system/components/<Card>/mobile.json). This module is
// what the browser reads, so a component and its card cannot drift.
// Regenerate with: node scripts/design-system/mobile-rules.mjs
// docs/DESIGN_SYSTEM.md, docs/MOBILE_TESTS.md.

// The three widths (docs/MOBILE_TESTS.md): phone up to 639px, tablet
// 640–1023px, desk from 1024px.
export const WIDTHS = Object.freeze({
  phone: '(max-width: 639px)',
  tabletMin: '(min-width: 640px)',
  tabletMax: '(max-width: 1023px)',
  desk: '(min-width: 1024px)',
});

export const RULES = {
  "bulkBar": {
    "component": "bulkBar",
    "direction": "foot bar",
    "phone": {
      "layout": "foot"
    },
    "tablet": {
      "layout": "foot"
    },
    "desk": {
      "layout": "foot"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "invoices-ticked"
    ],
    "card": "BulkBar"
  },
  "fx-btn": {
    "component": "fx-btn",
    "direction": "44px control",
    "phone": {
      "layout": "control"
    },
    "tablet": {
      "layout": "control"
    },
    "desk": {
      "layout": "control"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "invoice",
      "reconcile",
      "price-list",
      "rules",
      "automations",
      "integrations",
      "custom-fields",
      "appearance"
    ],
    "mark": false,
    "card": "Button"
  },
  "cardRows": {
    "component": "cardRows",
    "direction": "card per row",
    "phone": {
      "layout": "cards"
    },
    "tablet": {
      "layout": "table"
    },
    "desk": {
      "layout": "table"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "invoice",
      "invoice-issued"
    ],
    "card": "CardRows"
  },
  "columnTable": {
    "component": "columnTable",
    "direction": "two-line row",
    "phone": {
      "layout": "two-line",
      "rowHeight": 56,
      "slots": {
        "title": 2,
        "end": 1,
        "meta": 3
      },
      "columnFlag": "phone",
      "flags": [
        "title",
        "meta",
        "end",
        "hide"
      ]
    },
    "tablet": {
      "layout": "table",
      "sticky": "first"
    },
    "desk": {
      "layout": "table"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-list",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile",
      "price-list"
    ],
    "minRowsAt375": 7,
    "card": "Columns"
  },
  "crumbs": {
    "component": "crumbs",
    "direction": "trail",
    "phone": {
      "layout": "trail"
    },
    "tablet": {
      "layout": "trail"
    },
    "desk": {
      "layout": "trail"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "Crumbs"
  },
  "dialog": {
    "component": "dialog",
    "direction": "sheet",
    "phone": {
      "layout": "sheet"
    },
    "tablet": {
      "layout": "dialog"
    },
    "desk": {
      "layout": "dialog"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "Dialog"
  },
  "fieldError": {
    "component": "fieldError",
    "direction": "field",
    "phone": {
      "layout": "field"
    },
    "tablet": {
      "layout": "field"
    },
    "desk": {
      "layout": "field"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "FieldError"
  },
  "viewBar": {
    "component": "viewBar",
    "direction": "sheet",
    "phone": {
      "layout": "sheet"
    },
    "tablet": {
      "layout": "panel"
    },
    "desk": {
      "layout": "panel"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile"
    ],
    "card": "Filter"
  },
  "findBox": {
    "component": "findBox",
    "direction": "icon",
    "phone": {
      "layout": "icon"
    },
    "tablet": {
      "layout": "icon"
    },
    "desk": {
      "layout": "icon"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile"
    ],
    "card": "FindBox"
  },
  "holdButton": {
    "component": "holdButton",
    "direction": "wait",
    "phone": {
      "layout": "wait"
    },
    "tablet": {
      "layout": "wait"
    },
    "desk": {
      "layout": "wait"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "mark": false,
    "card": "HoldButton"
  },
  "lucide": {
    "component": "lucide",
    "direction": "icon",
    "phone": {
      "layout": "icon"
    },
    "tablet": {
      "layout": "icon"
    },
    "desk": {
      "layout": "icon"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "mark": false,
    "card": "Icon"
  },
  "jobChangeBanner": {
    "component": "jobChangeBanner",
    "direction": "banner",
    "phone": {
      "layout": "banner"
    },
    "tablet": {
      "layout": "banner"
    },
    "desk": {
      "layout": "banner"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "JobChangeBanner"
  },
  "listFrame": {
    "component": "listFrame",
    "direction": "frame",
    "phone": {
      "layout": "page"
    },
    "tablet": {
      "layout": "frame"
    },
    "desk": {
      "layout": "frame"
    },
    "touch": 44,
    "pageOverflow": "none",
    "scrollX": ".fx-frame, .fx-board, .fx-board-tabs",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile"
    ],
    "card": "ListFrame"
  },
  "listHead": {
    "component": "listHead",
    "direction": "one row",
    "phone": {
      "layout": "one-row"
    },
    "tablet": {
      "layout": "toolbar"
    },
    "desk": {
      "layout": "toolbar"
    },
    "touch": 44,
    "pageOverflow": "none",
    "scrollX": ".fx-toolbar__tools",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile"
    ],
    "card": "ListHead"
  },
  "listPager": {
    "component": "listPager",
    "direction": "slim foot",
    "phone": {
      "layout": "slim"
    },
    "tablet": {
      "layout": "full"
    },
    "desk": {
      "layout": "full"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter"
    ],
    "card": "ListPager"
  },
  "messagePage": {
    "component": "messagePage",
    "direction": "card",
    "phone": {
      "layout": "card"
    },
    "tablet": {
      "layout": "card"
    },
    "desk": {
      "layout": "card"
    },
    "touch": 44,
    "pageOverflow": "none",
    "mark": false,
    "screens": [],
    "card": "MessagePage"
  },
  "notice": {
    "component": "notice",
    "direction": "note",
    "phone": {
      "layout": "note",
      "short": "one line in place of the title and text"
    },
    "tablet": {
      "layout": "note"
    },
    "desk": {
      "layout": "note"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "invoice-offer"
    ],
    "card": "Notice"
  },
  "optionPill": {
    "component": "optionPill",
    "direction": "pill",
    "phone": {
      "layout": "pill"
    },
    "tablet": {
      "layout": "pill"
    },
    "desk": {
      "layout": "pill"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "mark": false,
    "card": "OptionPill"
  },
  "pageHeader": {
    "component": "pageHeader",
    "direction": "title",
    "phone": {
      "layout": "title"
    },
    "tablet": {
      "layout": "title"
    },
    "desk": {
      "layout": "title"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "invoice",
      "reconcile",
      "price-list",
      "rules",
      "automations",
      "integrations",
      "custom-fields",
      "appearance"
    ],
    "card": "PageHeader"
  },
  "fx-pager": {
    "component": "fx-pager",
    "direction": "record bar",
    "phone": {
      "layout": "bar"
    },
    "tablet": {
      "layout": "bar"
    },
    "desk": {
      "layout": "bar"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "invoice"
    ],
    "mark": false,
    "selector": ".fx-pager",
    "card": "Pager"
  },
  "pickOne": {
    "component": "pickOne",
    "direction": "sheet list",
    "phone": {
      "layout": "sheet"
    },
    "tablet": {
      "layout": "dialog"
    },
    "desk": {
      "layout": "dialog"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "Pick"
  },
  "rowMenu": {
    "component": "rowMenu",
    "direction": "menu",
    "phone": {
      "layout": "menu"
    },
    "tablet": {
      "layout": "menu"
    },
    "desk": {
      "layout": "menu"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "RowMenu"
  },
  "savedViews": {
    "component": "savedViews",
    "direction": "scrolling tabs",
    "phone": {
      "layout": "scroll"
    },
    "tablet": {
      "layout": "tabs"
    },
    "desk": {
      "layout": "tabs"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "jobs-board",
      "jobs-list",
      "job-panel",
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "reconcile"
    ],
    "card": "SavedViews"
  },
  "settingRow": {
    "component": "settingRow",
    "direction": "sheet",
    "phone": {
      "layout": "sheet"
    },
    "tablet": {
      "layout": "row"
    },
    "desk": {
      "layout": "row"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "appearance",
      "integration-xero",
      "integration-seazona"
    ],
    "card": "SettingRow"
  },
  "sidecar": {
    "component": "sidecar",
    "direction": "full page",
    "phone": {
      "layout": "page"
    },
    "tablet": {
      "layout": "panel"
    },
    "desk": {
      "layout": "panel"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "job-panel"
    ],
    "card": "Sidecar"
  },
  "fx-tabs": {
    "component": "fx-tabs",
    "direction": "scrolling tabs",
    "phone": {
      "layout": "scroll"
    },
    "tablet": {
      "layout": "tabs"
    },
    "desk": {
      "layout": "tabs"
    },
    "touch": 44,
    "pageOverflow": "none",
    "scrollX": ".fx-tabs",
    "screens": [
      "invoices-ready",
      "invoices-pending",
      "invoices-approved",
      "invoices-ticked",
      "invoices-filter",
      "price-list"
    ],
    "mark": false,
    "selector": ".fx-tabs",
    "card": "Tabs"
  },
  "tileCard": {
    "component": "tileCard",
    "direction": "one-line rows",
    "phone": {
      "layout": "one-line",
      "rowHeight": 56
    },
    "tablet": {
      "layout": "cards"
    },
    "desk": {
      "layout": "cards"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "rules",
      "integrations"
    ],
    "card": "Tiles"
  },
  "tileSection": {
    "component": "tileSection",
    "direction": "one-line rows",
    "phone": {
      "layout": "one-line",
      "rowHeight": 56
    },
    "tablet": {
      "layout": "cards"
    },
    "desk": {
      "layout": "cards"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [
      "rules"
    ],
    "card": "Tiles"
  },
  "named": {
    "component": "named",
    "direction": "tip",
    "phone": {
      "layout": "tip"
    },
    "tablet": {
      "layout": "tip"
    },
    "desk": {
      "layout": "tip"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "mark": false,
    "card": "Tip"
  },
  "toast": {
    "component": "toast",
    "direction": "toast",
    "phone": {
      "layout": "toast"
    },
    "tablet": {
      "layout": "toast"
    },
    "desk": {
      "layout": "toast"
    },
    "touch": 44,
    "pageOverflow": "none",
    "screens": [],
    "card": "Toast"
  }
};

// The card's rules for one component (columnTable, listHead, sidecar, …).
export function rule(component) {
  const found = RULES[component];
  if (!found) throw new Error(`No phone rules for ${component}`);
  return found;
}

export function isPhone() {
  return typeof matchMedia === 'function' && matchMedia(WIDTHS.phone).matches;
}

export function isTablet() {
  return typeof matchMedia === 'function' && matchMedia(WIDTHS.tabletMin).matches && matchMedia(WIDTHS.tabletMax).matches;
}

// The layout the card names for the width the page is at now.
export function layoutFor(component) {
  const found = rule(component);
  if (isPhone()) return found.phone.layout;
  if (isTablet()) return found.tablet.layout;
  return found.desk?.layout ?? found.tablet.layout;
}

// The rules that list this phone-suite screen.
export function rulesFor(screenId) {
  return Object.values(RULES).filter((found) => found.screens?.includes(screenId));
}

// Mark an element with the layout, touch size and row height from its card,
// and keep the mark current when the window crosses a width. The phone suite
// reads these marks.
export function applyPhoneRule(el, component) {
  const found = rule(component);
  if (!el?.dataset) return el;
  const paint = () => {
    el.dataset.phoneRule = component;
    el.dataset.phoneLayout = layoutFor(component);
    el.dataset.phoneTouch = String(found.touch);
    if (isPhone() && found.phone.rowHeight) el.dataset.phoneRowHeight = String(found.phone.rowHeight);
    else delete el.dataset.phoneRowHeight;
  };
  paint();
  if (typeof matchMedia === 'function' && !el.dataset.phoneWatch) {
    el.dataset.phoneWatch = '1';
    for (const query of [WIDTHS.phone, WIDTHS.tabletMin, WIDTHS.desk]) matchMedia(query).addEventListener?.('change', paint);
  }
  return el;
}

// A list column's phone slot, from the flag the Columns card names
// (phone: 'title' | 'meta' | 'end' | 'hide'). Anything else is unset.
export function phoneSlot(column) {
  const found = rule('columnTable');
  const value = column?.[found.phone.columnFlag];
  return found.phone.flags?.includes(value) ? value : null;
}

// Defaults for one list's columns. An explicit phone flag wins, up to the
// card's slot counts. Otherwise the first column is the title, the money
// column (kind total, or num) is the end, a stage or status leads the meta
// line, and further columns are meta in order. Past the slot counts, hide.
export function assignPhoneSlots(columns) {
  const { slots } = rule('columnTable').phone;
  const counts = { title: 0, end: 0, meta: 0 };
  const room = (slot) => slot === 'hide' || counts[slot] < slots[slot];
  const claim = (slot) => {
    if (slot !== 'hide') counts[slot] += 1;
    return slot;
  };
  const chosen = columns.map((column) => {
    const explicit = phoneSlot(column);
    if (!explicit) return null;
    return room(explicit) ? claim(explicit) : 'hide';
  });
  const open = () => chosen.findIndex((slot) => slot == null);
  const give = (index, slot) => {
    if (index < 0 || !room(slot)) return;
    chosen[index] = claim(slot);
  };
  give(open(), 'title');
  give(columns.findIndex((column, index) => chosen[index] == null && (column.kind === 'total' || column.num)), 'end');
  give(columns.findIndex((column, index) => chosen[index] == null && (column.kind === 'stage' || column.kind === 'status')), 'meta');
  let index = open();
  while (index >= 0) {
    chosen[index] = room('meta') ? claim('meta') : 'hide';
    index = open();
  }
  return columns.map((column, i) => (column.phone === chosen[i] ? column : { ...column, phone: chosen[i] }));
}
