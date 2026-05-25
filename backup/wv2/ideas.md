# Improvement Ideas

1. Pinned, fixed-size viewport controls
   Keep the important buttons fixed to the viewport at all times, independent of map zoom, pan, orientation, or control visibility. The buttons should never resize, wrap unpredictably, or move off-screen. The hide/show controls button should still work, but it should only hide optional controls, not essential map interaction buttons.

2. Bottom-left zoom controls
   Add fixed + and - buttons in the bottom-left corner. They should be large enough for thumbs, stay above the map, respect safe-area insets, and work even when the main controls are hidden.

3. Split controls into essential and secondary groups
   Essential controls could include zoom, center, hide/show controls, and maybe reset. Secondary controls could include lines/stops, line names, status, and rules.

4. Add a compact current-state HUD
   Show whether the map is using the full mission area or a pinned 1/4-mile zone, whether transit overlays are visible, and whether GPS is active.

5. Make long-press pinning clearer
   Add a brief visual press indicator when the user is holding on the map, so it is obvious that a pin is about to be dropped.

6. Add a drop-pin confirmation step
   Long-press could place a temporary pin first, then show fixed Confirm and Cancel buttons. This would prevent accidental mission-area changes.

7. Improve out-of-bounds warning usability
   Keep the warning strong, but include a fixed Center on Me or Return to Map button so the user can immediately recover.

8. Use icon buttons for map tools
   Replace some text controls with icons for center, reset, zoom, layers, rules, and status. Text can stay in tooltips or accessible labels.

9. Add a location accuracy indicator
   GPS can be wrong. Showing accuracy, such as GPS accuracy: 24 ft, would help players know whether a warning is trustworthy.

10. Add a follow-me mode - implemented
    Add a toggle that keeps the map centered on the player while moving, separate from the one-time Center action.

11. Make transit overlays easier to scan - implemented
    Instead of one orange style for all lines, use three route colors per route type. Lines that cross at intersections should not share a color within the same type; lines that travel along the same stretch can share a color.

12. Add offline and loading states - implemented
    Make it obvious when map tiles, transit data, or GPS are unavailable instead of only showing a temporary status message.

13. Add a visible-routes drawer - implemented
    Add a slide-up bottom pane that lists transit routes currently visible in the map viewport, grouped by Rail and Bus, using the same route/name labels as the status view.
