# Windows resize behavior: findings for Lasso

Research date: 2026-08-09

This note separates the behavior implemented by the Windows desktop window
manager from the modifier conventions used by Microsoft object-editing apps
and PowerToys. That distinction matters: a browser selection rectangle is an
object transform, not a native top-level `HWND`.

## Verified Windows-native behavior

### Resizing is driven by hit testing the non-client border

Windows asks the window which region is under the pointer with
`WM_NCHITTEST`. The documented resize regions are eight directional zones:

- `HTLEFT`, `HTRIGHT`, `HTTOP`, `HTBOTTOM`
- `HTTOPLEFT`, `HTTOPRIGHT`, `HTBOTTOMLEFT`, `HTBOTTOMRIGHT`

The four edge zones resize along one axis. The four corner zones resize
diagonally. The documented contract does not require tiny visible handles; it
only requires that the hit-test result identify the relevant edge or corner.

Source: [WM_NCHITTEST message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-nchittest)

### The sizing operation receives an edge/corner, not a modifier policy

During a native resize, Windows sends `WM_SIZING`. Its `wParam` identifies the
same eight edge/corner directions (`WMSZ_LEFT`, `WMSZ_TOPRIGHT`, and so on),
and its `RECT` can be adjusted by the application. The message documentation
does not define Alt, Shift, or Alt+Shift behavior for preserving aspect ratio
or resizing from the center.

Source: [WM_SIZING message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-sizing)

### Native sizing enters a modal move/size loop

`WM_ENTERSIZEMOVE` is sent after a user starts moving or sizing a window from
the title bar or sizing border, or after the app starts `SC_MOVE`/`SC_SIZE` via
`WM_SYSCOMMAND`. This explains the characteristic Windows feel: one captured
gesture owns the pointer until release, and the active edge remains fixed.

Source: [WM_ENTERSIZEMOVE message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-entersizemove)

### Border metrics are system/theme values

`GetSystemMetrics` exposes border and frame metrics such as `SM_CXBORDER`,
`SM_CYBORDER`, `SM_CXSIZEFRAME`, and `SM_CYSIZEFRAME`. The API documents these
as pixel dimensions, but it does not prescribe one universal resize hit-strip
width for every Windows version, theme, DPI, or custom frame.

Source: [GetSystemMetrics function - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetrics)

## What is *not* a Windows-native modifier contract

There is no Microsoft Win32/Windows 10/11 documentation saying that holding
`Alt` centers a native window resize, that `Shift` locks its aspect ratio, or
that `Alt+Shift` combines those operations. `WM_NCHITTEST`, `WM_SIZING`, and
`WM_ENTERSIZEMOVE` define the border/corner and resize-rectangle plumbing, but
not those keyboard policies.

`Alt` has other native meanings, including activating the window menu. Microsoft
documents this in `WM_SYSCOMMAND` (`SC_KEYMENU`), which is why an app that uses
Alt for a custom gesture may need to suppress the menu side effect.

Source: [WM_SYSCOMMAND message - Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-syscommand)

## Microsoft features that can look like “Windows resize”

### PowerToys Grab And Move

Microsoft's PowerToys utility adds a separate gesture layer. With its default
`Alt` activation key, `Alt` + left-drag moves a window from anywhere inside it;
`Alt` + right-drag resizes from the nearest edge or corner. The utility also
allows the Windows key as the activation modifier. This is not the native
window-manager contract; it is an optional PowerToys feature that improves
access to the existing move/resize operation.

Source: [PowerToys Grab And Move - Microsoft Learn](https://learn.microsoft.com/en-us/windows/powertoys/grab-and-move)

### Microsoft Office object resizing

For pictures, shapes, and text boxes, Microsoft documents a different object
transform convention:

- `Ctrl` + drag: keep the center fixed (expand/contract around center).
- `Shift` + drag a corner: maintain proportions.
- `Ctrl+Shift` + corner drag: maintain proportions and keep the center fixed.

The Office documentation also describes `Alt` as a snapping override, not a
center-resize modifier. This is the closest first-party reference for a
selection rectangle because Lasso resizes a captured object rather than a
native desktop window.

Source: [Change the size of a picture, shape, text box, or WordArt - Microsoft Support](https://support.microsoft.com/en-us/office/graphics-visuals/change-the-size-of-a-picture-shape-text-box-or-wordart)

## Implementation implications for Lasso

1. Treat the entire perimeter as the interaction target. Use four broad edge
   strips plus four corner regions with corner priority. Keep the visible
   geometry quiet; the hit target can be larger than the 1px/2px frame.
2. Once a drag starts, capture the pointer and keep the initially selected
   edge/corner fixed. Recompute the rectangle from the pointer delta on every
   move, then enforce minimum size and viewport bounds.
3. Do not describe `Alt` + center resize as “Windows native.” If Lasso wants
   the familiar Microsoft object-transform behavior, use the documented
   Office mapping: `Ctrl` for center, `Shift` for aspect ratio, and
   `Ctrl+Shift` for both. If product copy intentionally keeps `Alt`, label it
   as a Lasso convention and still implement the same geometry.
4. For edge drags, aspect locking needs an explicit policy because an edge has
   only one pointer axis. A practical object-editor policy is to derive the
   perpendicular dimension from the starting aspect ratio while keeping the
   opposite edge centered when center mode is active.
5. Use the active edge/corner as the source of cursor direction and transform
   math, not whichever corner happens to be visually easiest to reach.

## Bottom line

The Windows part to copy is the interaction model: a forgiving perimeter hit
area, eight directional resize zones, pointer capture, and an anchored active
edge. The modifier behavior requested for Lasso is an object-editor feature;
Microsoft's first-party object-resize docs support `Ctrl`/`Shift`/`Ctrl+Shift`,
while native Windows and PowerToys use `Alt` for access gestures rather than
center/aspect geometry.
