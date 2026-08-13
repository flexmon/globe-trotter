#version 300 es
precision highp float;

in vec2 v_uv;

uniform vec4 u_bgColor;      // rgba background
uniform vec4 u_borderColor;  // rgba border
uniform float u_borderWidth;  // pixels
uniform vec4 u_chartRect;    // x, y, w, h in pixels
uniform vec2 u_resolution;

out vec4 fragColor;

void main() {
    // Convert UV back to pixel position
    vec2 pixel = v_uv * u_resolution;

    // Distance from each edge of the chart rect (inward = positive)
    float left   = pixel.x - u_chartRect.x;
    float right  = (u_chartRect.x + u_chartRect.z) - pixel.x;
    float bottom = pixel.y - u_chartRect.y;
    float top    = (u_chartRect.y + u_chartRect.w) - pixel.y;

    float edgeDist = min(min(left, right), min(bottom, top));

    // Border band
    float borderMask = smoothstep(0.0, 1.0, edgeDist) - smoothstep(u_borderWidth - 1.0, u_borderWidth, edgeDist);

    // Subtle inner gradient — slightly lighter at top
    float gradientFactor = 1.0 + (pixel.y - u_chartRect.y) / u_chartRect.w * 0.08;

    vec4 bg = u_bgColor * vec4(vec3(gradientFactor), 1.0);
    fragColor = mix(bg, u_borderColor, borderMask);
}
