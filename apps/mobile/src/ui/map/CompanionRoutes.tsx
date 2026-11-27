import { memo, useMemo } from 'react';
import { LineLayer, ShapeSource, type LineLayerStyle } from '@rnmapbox/maps';
import { useDriveAlong } from '../../core/companions';

// Constant style (D28): a faint dashed line under our own route.
const STYLE: LineLayerStyle = { lineColor: '#8E7CFF', lineOpacity: 0.45, lineWidth: 4, lineDasharray: [1.5, 1.5], lineCap: 'round', lineJoin: 'round', lineEmissiveStrength: 1 };

/** Routes drive-along companions chose to share (D31). Re-renders only when a shared route changes (≈ once a minute). */
export const CompanionRoutes = memo(function CompanionRoutes() {
  const routes = useDriveAlong((s) => s.routes);
  const shape = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: Object.entries(routes).map(([id, r]) => ({ type: 'Feature' as const, id, properties: {}, geometry: { type: 'LineString' as const, coordinates: r.line.map((p) => [p.lng, p.lat]) } })),
    }),
    [routes],
  );
  if (shape.features.length === 0) return null;
  return (
    <ShapeSource id="companion-routes" shape={shape}>
      <LineLayer id="companion-routes-line" slot="middle" style={STYLE} />
    </ShapeSource>
  );
});
