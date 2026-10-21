// The design system's bundle: the real server/ui modules, as one script that
// sets window.FlowDesignSystem (scripts/design-system/build.mjs). A card calls
// these, so what a card shows is what the app draws.
import { crumbs, dialog, h, helpLink, holdButton, notice, pageHeader, rowMenu, sectionTitle, settingRow, tileCard, tileSection, toast } from '/assets/ui/kit.js';
import { findBox, ICONS, svg, viewBar } from '/assets/ui/view-bar.js';
import { bulkBar } from '/assets/ui/bulk-bar.js';
import { colorPicker, lucide, optionPill } from '/assets/ui/custom-fields.js';
import { jobChangeBanner } from '/assets/ui/job-change.js';
import { named, startTips } from '/assets/ui/tip.js';
import { sidecar } from '/assets/ui/sidecar.js';

// The colours of a custom field's options, read from server/core/custom-fields.js at build.
/* global __FLOW_OPTION_COLORS__ */
const OPTION_COLORS = __FLOW_OPTION_COLORS__;

// What app.js hands a view module, minus the network: enough for a card.
const ui = () => ({ h, toast, notice, pageHeader, sectionTitle, dialog, holdButton, me: null, flow: async () => ({}), go: () => {} });

// A toast needs its region, as on every Flow page.
function ready() {
  if (!document.getElementById('toasts')) document.body.append(h('div', { id: 'toasts', class: 'fx-toasts', 'aria-live': 'polite' }));
  startTips();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
else ready();

export {
  bulkBar, colorPicker, crumbs, dialog, findBox, h, helpLink, holdButton, ICONS, jobChangeBanner, lucide, named,
  notice, OPTION_COLORS, optionPill, pageHeader, rowMenu, sectionTitle, settingRow, sidecar, svg, tileCard, tileSection, toast, ui, viewBar,
};
