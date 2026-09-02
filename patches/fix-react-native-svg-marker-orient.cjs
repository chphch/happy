/**
 * react-native-svg does not implement SVG 2's `orient="auto-start-reverse"` on
 * markers, and its Android renderer hands the raw string to
 * `Double.parseDouble` — so any SVG whose arrowheads use that value CRASHES the
 * app while drawing:
 *
 *   java.lang.NumberFormatException: For input string: "auto-start-reverse"
 *     com.horcrux.svg.MarkerView.renderMarker(MarkerView.java:125)
 *
 * Measured on an emulator against react-native-svg 15.12.1; 15.15.5 (latest at
 * the time of writing) carries the identical line, so upgrading does not help.
 * The library already reserves `auto_start_reverse_` in RNSVGMarkerPosition
 * with a `// TODO`, so this finishes that.
 *
 * Apple hits the same gap without crashing — `[_orient doubleValue]` returns 0
 * for a non-numeric string, so markers silently render at the wrong angle.
 * Both are patched here so the two platforms agree.
 *
 * Semantics implemented (SVG 2 §marker): `auto-start-reverse` behaves like
 * `auto`, except a start marker is rotated a further 180°. Any other
 * unparseable value falls back to the property's initial value, 0, instead of
 * throwing.
 */
const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

const ANDROID_OLD = `    double markerAngle = "auto".equals(mOrient) ? -1 : Double.parseDouble(mOrient);
    float degrees = 180 + (float) (markerAngle == -1 ? position.angle : markerAngle);`;

const ANDROID_NEW = `    boolean autoStartReverse = "auto-start-reverse".equals(mOrient);
    double markerAngle;
    if ("auto".equals(mOrient) || autoStartReverse) {
      markerAngle = -1;
    } else {
      double parsedAngle = 0;
      try {
        parsedAngle = Double.parseDouble(mOrient);
      } catch (NumberFormatException | NullPointerException e) {
        // SVG: an invalid orient falls back to the initial value, 0.
        parsedAngle = 0;
      }
      markerAngle = parsedAngle;
    }
    float degrees = 180 + (float) (markerAngle == -1 ? position.angle : markerAngle);
    if (autoStartReverse && position.type == RNSVGMarkerType.kStartMarker) {
      degrees += 180;
    }`;

const APPLE_OLD = `  float markerAngle = [@"auto" isEqualToString:_orient] ? -1 : [_orient doubleValue];
  float angle = 180 + (markerAngle == -1 ? [position angle] : markerAngle);`;

const APPLE_NEW = `  BOOL autoStartReverse = [@"auto-start-reverse" isEqualToString:_orient];
  float markerAngle =
      ([@"auto" isEqualToString:_orient] || autoStartReverse) ? -1 : [_orient doubleValue];
  float angle = 180 + (markerAngle == -1 ? [position angle] : markerAngle);
  if (autoStartReverse && [position type] == kStartMarker) {
    angle += 180;
  }`;

let patched = 0;
let alreadyPatched = 0;

function apply(file, oldText, newText, marker) {
    if (!fs.existsSync(file)) return;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(marker)) {
        alreadyPatched++;
        return;
    }
    if (!content.includes(oldText)) {
        // Fail loudly: a silent no-op here would ship the crash while the log
        // still reads like a successful postinstall.
        console.warn(`[patch] react-native-svg marker orient: anchor NOT found in ${file} — NOT patched`);
        return;
    }
    fs.writeFileSync(file, content.replace(oldText, newText), 'utf8');
    patched++;
}

for (const root of nodeModulesRoots) {
    apply(
        path.join(root, 'react-native-svg/android/src/main/java/com/horcrux/svg/MarkerView.java'),
        ANDROID_OLD,
        ANDROID_NEW,
        'autoStartReverse'
    );
    apply(
        path.join(root, 'react-native-svg/apple/Elements/RNSVGMarker.mm'),
        APPLE_OLD,
        APPLE_NEW,
        'autoStartReverse'
    );
}

if (patched > 0 || alreadyPatched > 0) {
    console.log(
        `[patch] react-native-svg marker orient=auto-start-reverse (${patched} patched, ${alreadyPatched} already)`
    );
}
