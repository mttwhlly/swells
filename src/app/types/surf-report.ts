export interface SurfReport {
  id: string;
  timestamp: string;
  location: string;
  report: string;
  conditions: {
    /** Significant wave height (Hs) offshore — the measured quantity, not the wave face. */
    wave_height_ft: number;
    /** Estimated breaking face height. Derived, not measured — see lib/waveSize.ts. */
    face_height_ft?: number;
    /** Body-scale size band ("chest to shoulder high"). Preferred for anything user-facing. */
    size_descriptor?: string;
    wave_period_sec: number;
    wind_speed_kts: number;
    wind_direction_deg: number;
    tide_state: string;
    weather_description: string;
    surfability_score: number;
    
    // 🆕 Added compass direction fields
    swell_direction_deg?: number;
    swell_direction_compass?: string;
    swell_direction_text?: string;
    swell_direction_description?: string;
    wind_direction_compass?: string;
    wind_direction_text?: string;
    wind_direction_description?: string;
    
    // 🆕 Added additional fields from surfability API
    tide_height_ft?: number;
    water_temperature_c?: number;
    water_temperature_f?: number;
    air_temperature_c?: number;
    air_temperature_f?: number;
  };
  recommendations: {
    board_type: string;
    wetsuit_thickness?: string;
    skill_level: 'beginner' | 'intermediate' | 'advanced';
    best_spots?: string[];
    timing_advice?: string;
  };
  cached_until: string;

  // Provenance — which tier actually produced this report. Absent on very old cached
  // rows written before this field existed; treat that as the normal live-AI case.
  generation_meta?: {
    backend: string;
    model: string;
    report_length: number;
    word_count: number;
    paragraphs: number;
    prompt_version: string;
    validation_issues?: string[];
  };

  // Set only by the emergency cache fallback in /api/surf-report when fresh
  // generation fails entirely and a stale row (of any age) is served instead.
  _fallback?: boolean;
  _error?: string;
}