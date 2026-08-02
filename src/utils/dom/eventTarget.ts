// `Event.target` is typed `EventTarget | null`, which every
// containment check ("was this click inside my popup?") has to turn
// into a `Node` first. `instanceof` is the real runtime check; the
// result deliberately stops at `Node` because an SVG icon inside a
// button is a legitimate click target and narrowing further to
// `HTMLElement` would report it as "outside".

export function eventTargetNode(event: Event): Node | null {
  const { target } = event;
  return target instanceof Node ? target : null;
}
