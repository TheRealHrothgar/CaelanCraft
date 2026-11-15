# Caelancraft — Brick Lattice over the Honeycomb (v3, 2026-11-14)

The normative contract is `src/CONTRACTS.md` §93. This document records why the design is what it is.

## 1. Decision

The world stays a honeycomb of hexagonal prisms. Terrain and raw resources stay hexes. Building materials are laid as
**bricks** on a second, rectangular lattice fixed to the hexes, so that builders get straight walls along X and along Z that
meet at right angles. No half blocks; sprites unchanged.

A brick is **1 wide, 1/√3 ≈ 0.577 deep, 1 tall**: the width of a hex, half a hex's point-to-point height, one layer. (An
earlier draft used 0.866, the hex row pitch; that was a misreading of the sketches and is gone.)

## 2. Why every other geometry was dropped

- A hexagonal prism can never have a flat run of wall along both X and Z: its sides are at 60° to each other.
- Per-cell shape bytes (half hexes, wedges, rotated inscribed bricks) give straight pieces inside one cell, but the pieces of
  neighbouring cells never line up into a long straight face, and every system that reads a cell would need to know shapes.
- Triangular prisms and a unit-cube grid over the hexes do not share edges with the hexes: the two lattices overlap
  partially everywhere, so every face of one fights or gaps against the other.

The rectangle 1 × 1/√3 is the one cell whose edges all lie on lines the hexes already have (§3), so the lattices never
overlap partially.

## 3. The shifted layout

Of the two placements the sketches allowed, the lattice is shifted half a hex: vertical seams run through the centres of
even-row hexes and along the E and W faces of odd-row hexes; horizontal seams run through an even row's top point, centre and
bottom point, and along an odd row's vertical faces. The pattern repeats every 3 brick rows = 2 hex rows (24 brick rows = 16
hex rows, so brick chunks are 16 × 24 and match hex chunks in depth).

Every brick covers exactly **one piece** of each hex it touches: a quarter of an even-row hex (cut through its centre both
ways), or the top point, the middle or the bottom point of an odd-row hex. One brick row in three lies wholly inside single
hexes (it covers only odd-row middles); the other two touch three hexes each. Compared with the unshifted layout it touches
fewer hexes (2.33 on average, not 2.67), and a third of all bricks need only one hex cleared to be set into dug ground.

The overlap tables (`hexesOfBrick`, `bricksOfHex`) are integer formulas, checked in the tests against exact polygon
clipping.

## 4. One mechanism keeps everything else unchanged: the shadow

Mobs, support, falling blocks, placement, sleep and the scheduler all ask the hex world what is solid. Rather than teach
each of them about bricks, a hex cell a brick touches is written a **derived** id: BRICK_FILL (all of it opaque brick),
BRICK_GAP (some of it brick, the rest one open space) or BRICK_SHADOW (otherwise). These are never saved or edited: they are
re-derived from the bricks whenever a brick changes and whenever a chunk is generated. Each cell also carries its covered
pieces (`chunk.cover`).

Rendering, aiming and the player read the bricks exactly (their own mesher, raycast and collider). Mobs see the shadows,
so they stop up to half a cell short of a brick wall: the accepted cost.

## 5. Water: piece by piece

Treating every brick-touched hex as solid to water held pools, but left a dry zigzag strip at the foot of every wall, and a
channel needed three brick rows before a single hex lay clear of both walls. So water reads brickwork at piece resolution:

- A hex whose open pieces form one space (a gap) can hold water; one split into two points that touch at a corner only
  cannot (a single cell id cannot hold two waters).
- Water crosses a face only where open pieces meet it on both sides. A brick that spans a face covers both sides of it at
  once, so the two sides disagree only along odd rows' E and W faces, which are brick seams.
- A pool reaches into the gaps beside it and pays for them out of its own water (no water is made), so it stays contained
  against a wall where the wall really is.
- The points a wall splits off are drawn full of the water beside them, so a surface meets every brick wall in a straight
  line.

Results: a brick basin holds its pool whichever brick row its walls are in; a channel one brick wide carries water; a hole one
brick wide drains a pool as a dug channel does. A small pool loses a level or so to its walls' gaps and may stand at two
depths a level apart; that is the existing levelling rule (§83) showing.

## 6. Materials and terraforming

Raw materials stay hexes and are worked into building materials when mined: stone gives rocks to a pick, or stone bricks to
a metal hammer; dirt gives loose dirt; wood gives logs, and logs planks. Survival never places raw blocks. Loose ground
(dirt, sand, gravel, snow, clay, red sand) is the one thing Survival still places as hexes, for berms and ditches, and only
up to three layers above the land's generated height: earthworks, never mountains. Creative places anything, and **B**
switches its building materials between bricks and hexes.

## 7. Not done yet

- Brick-material icons still draw a hex prism; a brick icon would read better.
- The handbook does not mention bricks yet.
- Bricks have no gravity, support or collapse, and explosions and fire leave them alone.
- Mobs collide with the shadows, not the bricks.
