#version 300 es
precision highp float;

uniform sampler2D u_glyphAtlas;

in vec2 v_uv;
in vec4 v_color;

out vec4 fragColor;

void main() {
    float alpha = texture(u_glyphAtlas, v_uv).a;
    if (alpha < 0.05) discard;
    fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
