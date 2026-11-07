// Rendered board geometry and the visible surface beneath its cards.
export async function boardSurface(page) {
  return page.locator('.fx-board').evaluate((board) => {
    const surface = (element) => {
      for (let at = element; at; at = at.parentElement) {
        const colour = getComputedStyle(at).backgroundColor;
        if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
      }
      return 'transparent';
    };
    const rect = board.getBoundingClientRect();
    const lanes = [...board.querySelectorAll('.fx-board__col')];
    const boxes = lanes.map((lane) => lane.getBoundingClientRect());
    return {
      viewport: innerWidth,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      width: rect.width,
      scrollWidth: board.scrollWidth,
      scrollLeft: board.scrollLeft,
      surface: surface(board),
      laneSurfaces: lanes.map(surface),
      laneWidths: boxes.map((box) => box.width),
      gaps: boxes.slice(1).map((box, i) => box.left - boxes[i].right),
      cardGaps: lanes.map((lane) => getComputedStyle(lane.querySelector('.fx-board__cards')).rowGap),
      lastRight: boxes.at(-1).right,
      right: rect.right,
    };
  });
}
