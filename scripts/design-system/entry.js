// The design system's bundle: the real server/ui modules, as one script that
// sets window.FlowDesignSystem (scripts/design-system/build.mjs). A card calls
// these, so what a card shows is what the app draws.
import { cardRows, crumbs, dialog, edgeFade, fieldError, h, helpLink, holdButton, ICON_CHOICES, iconPicker, listFrame, listHead, notice, pageHeader, rowMenu, sectionTitle, settingRow, tileCard, tileSection, toast } from '/assets/ui/kit.js';
import { findBox, ICONS, svg, viewBar } from '/assets/ui/view-bar.js';
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { listPager, pager } from '/assets/ui/pager.js';
import { columnTable, onRightButton, rowCells, viewSaver } from '/assets/ui/columns.js';
import { colorPicker, lucide, optionPill } from '/assets/ui/custom-fields.js';
import { jobChangeBanner } from '/assets/ui/job-change.js';
import { named, startTips } from '/assets/ui/tip.js';
import { savedViews } from '/assets/ui/saved-views.js';
import { sidecar } from '/assets/ui/sidecar.js';
import { captureButton } from '/assets/ui/captures.js';

// The colours of a custom field's options, read from server/core/custom-fields.js at build.
/* global __FLOW_OPTION_COLORS__ */
const OPTION_COLORS = __FLOW_OPTION_COLORS__;

// What app.js hands a view module, minus the network: enough for a card.
const ui = () => ({ h, toast, notice, pageHeader, listHead, listFrame, sectionTitle, dialog, holdButton, me: null, flow: async () => ({}), go: () => {} });

// A toast needs its region, as on every Flow page.
function ready() {
  if (!document.getElementById('toasts')) document.body.append(h('div', { id: 'toasts', class: 'fx-toasts', 'aria-live': 'polite' }));
  startTips();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
else ready();

export {
  bulkBar, captureButton, cardRows, colorPicker, columnTable, crumbs, dialog, edgeFade, fieldError, findBox, h, helpLink, holdButton, ICON_CHOICES, iconPicker, ICONS, jobChangeBanner, listFrame, listHead, listPager, lucide, named, pager,
  notice, onRightButton, OPTION_COLORS, optionPill, pageHeader, rowCells, rowMenu, savedViews, sectionTitle, settingRow, sidecar, svg, tileCard,
  tileSection, toast, ui, viewBar, viewSaver,
};
