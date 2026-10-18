# -*- coding: utf-8 -*-
"""把《点定旅途-完整项目方案.md》排版为正式 Word 文档。

用法：
  python build_docx.py
输出：
  docs/resume/点定旅途-完整项目方案.docx
"""
import os
import re
import sys

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))  # workspace root
SRC = os.path.join(HERE, "点定旅途-完整项目方案.md")
DST = os.path.join(HERE, "点定旅途-完整项目方案.docx")
HEADER_TITLE = "点定旅途 · 完整项目方案"

GREEN = RGBColor(0x3B, 0x73, 0x56)
INK = RGBColor(0x18, 0x21, 0x19)
BODY = RGBColor(0x1F, 0x2A, 0x22)
GRAY = RGBColor(0x6B, 0x75, 0x68)
LINE = "D9E1D5"
BG_LIGHT = "F5F8F3"
BG_TABLE = "F7F9F5"
GREEN_HEX = "3B7356"

BODY_FONT = "宋体"
HEAD_FONT = "微软雅黑"
MONO_FONT = "Consolas"

PAGE_W = 21.0
MARGIN_L = 2.2
MARGIN_R = 2.2
USABLE = PAGE_W - MARGIN_L - MARGIN_R  # 16.6cm

# ---------------------------------------------------------------- XML helpers


def set_run_font(run, name=BODY_FONT, size=10.5, color=BODY, bold=None,
                 eastasia=None):
    run.font.name = name
    run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color
    if bold is not None:
        run.bold = bold
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), eastasia or name)


def style_run_font(style, name, size, color, bold=False):
    style.font.name = name
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = color
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)


def shade_cell(cell, fill):
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def set_cell_borders(cell, color=LINE, sz=4, edges=("top", "left", "bottom", "right")):
    tcpr = cell._tc.get_or_add_tcPr()
    borders = tcpr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tcpr.append(borders)
    for edge in edges:
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)


def set_table_borders(table, color=LINE, sz=4):
    tblpr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    tblpr.append(borders)


def set_table_no_borders(table):
    tblpr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        borders.append(el)
    tblpr.append(borders)


def set_cell_margins(table, top=45, bottom=45, left=90, right=90):
    tblpr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for edge, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblpr.append(mar)


def set_table_fixed(table, widths_cm):
    table.autofit = False
    tblpr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tblpr.append(layout)
    for i, w in enumerate(widths_cm):
        table.columns[i].width = Cm(w)
        for cell in table.columns[i].cells:
            cell.width = Cm(w)
    tblw = OxmlElement("w:tblW")
    tblw.set(qn("w:type"), "dxa")
    tblw.set(qn("w:w"), str(int(sum(widths_cm) * 567)))
    tblpr.append(tblw)


def mark_header_row(row, repeat=True):
    trpr = row._tr.get_or_add_trPr()
    if repeat:
        el = OxmlElement("w:tblHeader")
        el.set(qn("w:val"), "true")
        trpr.append(el)
    el2 = OxmlElement("w:cantSplit")
    trpr.append(el2)


def all_rows_cant_split(table):
    for row in table.rows:
        trpr = row._tr.get_or_add_trPr()
        el = OxmlElement("w:cantSplit")
        trpr.append(el)


def add_paragraph_bottom_border(p, color=GREEN_HEX, sz=10, space=4):
    ppr = p._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(sz))
    bottom.set(qn("w:space"), str(space))
    bottom.set(qn("w:color"), color)
    pbdr.append(bottom)
    ppr.append(pbdr)


def add_field(paragraph, instr, size=8.5, color=GRAY):
    run = paragraph.add_run()
    set_run_font(run, HEAD_FONT, size, color)
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    run._r.append(fld_begin)
    run2 = paragraph.add_run()
    set_run_font(run2, HEAD_FONT, size, color)
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = " %s " % instr
    run2._r.append(instr_el)
    run3 = paragraph.add_run()
    set_run_font(run3, HEAD_FONT, size, color)
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run3._r.append(fld_end)


# ---------------------------------------------------------------- md parsing

INLINE_RE = re.compile(r"(\*\*.+?\*\*|`[^`]+`)")
CODE_RE = re.compile(r"(`[^`]+`)")


def _add_code_run(p, text, size, color, bold, name):
    r = p.add_run(text)
    set_run_font(r, MONO_FONT, size - 0.5, RGBColor(0x2E, 0x57, 0x42),
                 bold, eastasia="微软雅黑")


def add_inline_runs(p, text, size=10.5, color=BODY, bold=False, name=BODY_FONT,
                    eastasia=None):
    for token in INLINE_RE.split(text):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**") and len(token) > 4:
            inner = token[2:-2]
            for sub in CODE_RE.split(inner):
                if not sub:
                    continue
                if sub.startswith("`") and sub.endswith("`") and len(sub) > 2:
                    _add_code_run(p, sub[1:-1], size, color, True, name)
                else:
                    r = p.add_run(sub)
                    set_run_font(r, name, size, color, bold=True, eastasia=eastasia)
        elif token.startswith("`") and token.endswith("`") and len(token) > 2:
            _add_code_run(p, token[1:-1], size, color, bold, name)
        else:
            # 斜体 *text*（不处理 ** 粗体已在上方消费）
            for piece in re.split(r"(\*[^*\n]+\*)", token):
                if not piece:
                    continue
                if piece.startswith("*") and piece.endswith("*") and len(piece) > 2:
                    r = p.add_run(piece[1:-1])
                    set_run_font(r, name, size, color, bold, eastasia=eastasia)
                    r.italic = True
                else:
                    r = p.add_run(piece)
                    set_run_font(r, name, size, color, bold, eastasia=eastasia)


def parse_blocks(md_text):
    lines = md_text.split("\n")
    blocks = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        # skip top H1 + meta block until the first "## "
        if stripped.startswith("<!-- pagebreak -->"):
            blocks.append({"type": "pagebreak"})
            i += 1
            continue
        if not stripped:
            i += 1
            continue
        if stripped == "---":
            i += 1
            continue
        if stripped.startswith("```"):
            i += 1
            code_lines = []
            while i < n and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i].rstrip())
                i += 1
            i += 1
            blocks.append({"type": "code", "lines": code_lines})
            continue
        if stripped.startswith("#"):
            m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
            if m:
                level = len(m.group(1))
                blocks.append({"type": "heading", "level": level, "text": m.group(2).strip()})
                i += 1
                continue
        if stripped.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                raw = lines[i].strip()
                if re.match(r"^\|[\s:\-\|]+\|$", raw):
                    i += 1
                    continue
                cells = [c.strip() for c in raw.strip("|").split("|")]
                rows.append(cells)
                i += 1
            if rows:
                blocks.append({"type": "table", "rows": rows})
            continue
        if stripped.startswith(">"):
            quoted = []
            while i < n and lines[i].strip().startswith(">"):
                quoted.append(re.sub(r"^>\s?", "", lines[i].strip()))
                i += 1
            blocks.append({"type": "quote", "lines": quoted})
            continue
        if stripped.startswith("!["):
            m = re.match(r"^!\[(.*?)\]\((.*?)\)\s*$", stripped)
            if m:
                blocks.append({"type": "image", "caption": m.group(1), "path": m.group(2)})
                i += 1
                continue
        if re.match(r"^[-*]\s+", stripped):
            items = []
            while i < n and re.match(r"^[-*]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[i].strip()))
                i += 1
            blocks.append({"type": "bullets", "items": items})
            continue
        if re.match(r"^\d+[\.、]\s+", stripped):
            blocks.append({"type": "numbered", "text": stripped})
            i += 1
            continue
        blocks.append({"type": "para", "text": stripped})
        i += 1
    return blocks


# ---------------------------------------------------------------- rendering


class Renderer:
    def __init__(self, doc):
        self.doc = doc
        self.pending_break = False

    def _maybe_break(self, paragraph):
        if self.pending_break:
            paragraph.paragraph_format.page_break_before = True
            self.pending_break = False

    # ---- text blocks
    def heading(self, level, text):
        style = {1: "Heading 1", 2: "Heading 1", 3: "Heading 2", 4: "Heading 3"}.get(level, "Heading 3")
        p = self.doc.add_paragraph(style=style)
        self._maybe_break(p)
        r = p.add_run(text)
        if level == 1:
            set_run_font(r, HEAD_FONT, 22, GREEN, bold=True)
            add_paragraph_bottom_border(p, GREEN_HEX, 12, 4)
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(10)
        elif level == 2:
            set_run_font(r, HEAD_FONT, 17, GREEN, bold=True)
            add_paragraph_bottom_border(p, GREEN_HEX, 10, 4)
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(10)
        elif level == 3:
            set_run_font(r, HEAD_FONT, 13, INK, bold=True)
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(5)
            # green left bar
            ppr = p._p.get_or_add_pPr()
            pbdr = OxmlElement("w:pBdr")
            left = OxmlElement("w:left")
            left.set(qn("w:val"), "single")
            left.set(qn("w:sz"), "18")
            left.set(qn("w:space"), "8")
            left.set(qn("w:color"), GREEN_HEX)
            pbdr.append(left)
            ppr.append(pbdr)
            p.paragraph_format.left_indent = Cm(0.15)
        else:
            set_run_font(r, HEAD_FONT, 11.5, GREEN, bold=True)
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.keep_with_next = True

    def para(self, text):
        p = self.doc.add_paragraph()
        self._maybe_break(p)
        add_inline_runs(p, text, 10.5, BODY)
        pf = p.paragraph_format
        pf.line_spacing = 1.5
        pf.space_after = Pt(4)
        pf.widow_control = True

    def bullets(self, items):
        for item in items:
            p = self.doc.add_paragraph()
            self._maybe_break(p)
            prefix = "" if item[:1] in ("❌", "✅", "⚠") else "• "
            add_inline_runs(p, prefix + item, 10.5, BODY)
            pf = p.paragraph_format
            pf.left_indent = Cm(0.55)
            pf.first_line_indent = Cm(-0.35)
            pf.line_spacing = 1.4
            pf.space_after = Pt(2)

    def numbered(self, text):
        p = self.doc.add_paragraph()
        self._maybe_break(p)
        add_inline_runs(p, text, 10.5, BODY)
        pf = p.paragraph_format
        pf.left_indent = Cm(0.55)
        pf.first_line_indent = Cm(-0.4)
        pf.line_spacing = 1.5
        pf.space_after = Pt(2)

    def quote(self, lines):
        table = self.doc.add_table(rows=1, cols=1)
        table.alignment = 1
        set_table_no_borders(table)
        cell = table.cell(0, 0)
        cell.width = Cm(USABLE)
        shade_cell(cell, BG_LIGHT)
        set_cell_borders(cell, GREEN_HEX, sz=24, edges=("left",))
        set_cell_margins(table, 90, 90, 150, 120)
        first = True
        for ln in lines:
            p = cell.paragraphs[0] if first else cell.add_paragraph()
            first = False
            m = re.match(r"^[-*]\s+(.*)$", ln.strip())
            if m:
                add_inline_runs(p, "• " + m.group(1), 9.8, RGBColor(0x33, 0x3D, 0x35))
                p.paragraph_format.left_indent = Cm(0.4)
                p.paragraph_format.first_line_indent = Cm(-0.32)
            else:
                add_inline_runs(p, ln, 9.8, RGBColor(0x33, 0x3D, 0x35))
            p.paragraph_format.line_spacing = 1.35
            p.paragraph_format.space_after = Pt(2)
        self._spacer(2)

    def code(self, lines):
        table = self.doc.add_table(rows=1, cols=1)
        set_table_no_borders(table)
        cell = table.cell(0, 0)
        cell.width = Cm(USABLE)
        shade_cell(cell, "F4F6F2")
        set_cell_borders(cell, LINE, sz=4)
        set_cell_margins(table, 100, 100, 150, 120)
        first = True
        for ln in lines:
            p = cell.paragraphs[0] if first else cell.add_paragraph()
            first = False
            r = p.add_run(ln if ln else " ")
            set_run_font(r, MONO_FONT, 8.6, RGBColor(0x25, 0x35, 0x2B), eastasia="微软雅黑")
            p.paragraph_format.line_spacing = 1.05
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.space_before = Pt(0)
        self._spacer(3)

    def _spacer(self, pts=2):
        p = self.doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run("")
        r.font.size = Pt(pts)

    # ---- table
    def table(self, rows):
        ncols = max(len(r) for r in rows)
        rows = [r + [""] * (ncols - len(r)) for r in rows]
        small = ncols >= 7
        size = 8.0 if small else (8.8 if ncols >= 5 else 9.2)
        table = self.doc.add_table(rows=len(rows), cols=ncols)
        table.alignment = 1
        set_table_borders(table, LINE, 4)
        set_cell_margins(table, 40, 40, 70, 70)

        # column widths: weight by content length
        weights = []
        for c in range(ncols):
            lens = [len(re.sub(r"\*\*|`", "", r[c])) for r in rows[1:]]
            maxlen = max(lens) if lens else 6
            weights.append(max(5.0, min(30.0, maxlen)))
        total = sum(weights)
        widths = [max(2.0, USABLE * w / total) for w in weights]
        scale = USABLE / sum(widths)
        widths = [w * scale for w in widths]
        set_table_fixed(table, widths)

        for ri, row in enumerate(rows):
            tr = table.rows[ri]
            for ci, value in enumerate(row):
                cell = tr.cells[ci]
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                p = cell.paragraphs[0]
                p.paragraph_format.space_before = Pt(0)
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.15
                if ri == 0:
                    shade_cell(cell, GREEN_HEX)
                    add_inline_runs(p, value, size, RGBColor(0xFF, 0xFF, 0xFF),
                                    bold=True, name=HEAD_FONT, eastasia=HEAD_FONT)
                else:
                    if ri % 2 == 0:
                        shade_cell(cell, BG_TABLE)
                    add_inline_runs(p, value, size, BODY)
        mark_header_row(table.rows[0])
        all_rows_cant_split(table)
        self._spacer(4)

    # ---- image
    def _abs_image(self, path):
        p1 = os.path.join(HERE, path)
        p2 = os.path.join(ROOT, path)
        for cand in (p1, p2):
            if os.path.exists(cand):
                return cand
        return None

    def _image(self, path, caption, width_cm):
        from PIL import Image
        abs_path = self._abs_image(path)
        if not abs_path:
            self.para("[图片缺失：%s]" % path)
            return
        with Image.open(abs_path) as im:
            w, h = im.size
        ratio = h / float(w)
        if width_cm is None:
            if ratio > 2.0:          # phone screenshot
                width_cm = 5.3
            elif ratio > 1.2:        # poster portrait
                width_cm = 9.2
            elif ratio < 0.8:        # landscape
                width_cm = 12.5
            else:
                width_cm = 8.0
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(4)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.keep_with_next = True
        p.paragraph_format.line_spacing = 1.0
        run = p.add_run()
        run.add_picture(abs_path, width=Cm(width_cm))
        cap = self.doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.paragraph_format.space_after = Pt(8)
        r = cap.add_run(caption)
        set_run_font(r, BODY_FONT, 8.6, GRAY)

    def image_groups(self, images):
        """连续手机截图两列排布，海报/横向图单独居中。"""
        from PIL import Image
        groups = []
        cur = []
        for img in images:
            abs_path = self._abs_image(img["path"])
            ratio = 2.2
            if abs_path:
                with Image.open(abs_path) as im:
                    w, h = im.size
                ratio = h / float(w)
            if ratio > 2.0:
                cur.append(img)
            else:
                if cur:
                    groups.append(("phone", cur))
                    cur = []
                groups.append(("single", [img]))
        if cur:
            groups.append(("phone", cur))
        for kind, imgs in groups:
            if kind == "single":
                self._image(imgs[0]["path"], imgs[0]["caption"], None)
            elif len(imgs) == 1:
                self._image(imgs[0]["path"], imgs[0]["caption"], 5.6)
            else:
                self._phone_grid(imgs)

    def _phone_grid(self, imgs):
        cols = 2
        rows = (len(imgs) + cols - 1) // cols
        table = self.doc.add_table(rows=rows, cols=cols)
        table.alignment = 1
        set_table_no_borders(table)
        set_cell_margins(table, 40, 60, 60, 60)
        cell_w = USABLE / cols
        set_table_fixed(table, [cell_w] * cols)
        for idx, img in enumerate(imgs):
            r, c = divmod(idx, cols)
            cell = table.cell(r, c)
            abs_path = self._abs_image(img["path"])
            if not abs_path:
                continue
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.0
            p.add_run().add_picture(abs_path, width=Cm(5.1))
            cap = cell.add_paragraph()
            cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cap.paragraph_format.space_after = Pt(2)
            rr = cap.add_run(img["caption"])
            set_run_font(rr, BODY_FONT, 8.2, GRAY)
        for c in range(cols):
            if len(imgs) <= c + (rows - 1) * cols:
                pass
        self._spacer(4)


# ---------------------------------------------------------------- cover / toc


def build_cover(doc):
    from docx.enum.text import WD_BREAK

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    r = p.add_run("")
    r.font.size = Pt(2)

    p = doc.add_paragraph()
    r = p.add_run("点定旅途  ·  DECIDENOW")
    set_run_font(r, HEAD_FONT, 10.5, GREEN, bold=True)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.line_spacing = 1.0

    p = doc.add_paragraph()
    r = p.add_run("点定旅途 · 完整项目方案")
    set_run_font(r, HEAD_FONT, 28, INK, bold=True)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.line_spacing = 1.05

    p = doc.add_paragraph()
    r = p.add_run("从 0 到 1 做一款「分钟级行程」AI 辅助旅行规划产品")
    set_run_font(r, HEAD_FONT, 12.5, RGBColor(0x4C, 0x5A, 0x50), bold=False)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.line_spacing = 1.15

    p = doc.add_paragraph()
    r = p.add_run("产品定义 · 方案设计 · 算法策略 · 工程落地 · 迭代复盘 · 简历转化")
    set_run_font(r, BODY_FONT, 10, GRAY)
    p.paragraph_format.space_after = Pt(10)
    p.paragraph_format.line_spacing = 1.0

    # divider
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(10)
    p.paragraph_format.line_spacing = 1.0
    add_paragraph_bottom_border(p, GREEN_HEX, 12, 1)

    meta = [
        ("项目名称", "点定旅途（DecideNow）· decidenow.asia"),
        ("项目周期", "2026.10.10 竞品调研 → 2026.10.19 持续迭代（首版 10.12，60 城 10.18）"),
        ("项目角色", "独立产品负责人（产品定义 / 方案设计 / 数据策略 / 全栈落地 / AI 协作开发）"),
        ("文档版本", "v1.0（2026-10-19）"),
        ("事实基准", "仓库快照 HEAD 84cde7d + 线上站点实测；关键数字见附录 B"),
        ("文档用途", "① 写实习项目简历的素材源  ② 面试项目深挖底稿  ③ 作品集/复盘"),
    ]
    table = doc.add_table(rows=len(meta), cols=2)
    table.alignment = 1
    set_table_no_borders(table)
    set_cell_margins(table, 30, 30, 70, 70)
    set_table_fixed(table, [3.1, 13.5])
    for i, (k, v) in enumerate(meta):
        c0, c1 = table.cell(i, 0), table.cell(i, 1)
        shade_cell(c0, "F3F6F2")
        set_cell_borders(c0, "E3E8E0", 4, ("bottom",))
        set_cell_borders(c1, "E3E8E0", 4, ("bottom",))
        p0 = c0.paragraphs[0]
        p0.paragraph_format.space_after = Pt(0)
        p0.paragraph_format.line_spacing = 1.1
        r0 = p0.add_run(k)
        set_run_font(r0, HEAD_FONT, 8.7, GREEN, bold=True)
        p1 = c1.paragraphs[0]
        p1.paragraph_format.space_after = Pt(0)
        p1.paragraph_format.line_spacing = 1.1
        r1 = p1.add_run(v)
        set_run_font(r1, BODY_FONT, 8.7, BODY)

    # cover image
    cover = os.path.join(ROOT, "brand", "cover-1200x630.png")
    if os.path.exists(cover):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(8)
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.0
        p.add_run().add_picture(cover, width=Cm(11.8))

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run("2026 年 10 月 · 产品实习项目材料")
    set_run_font(r, BODY_FONT, 8.7, GRAY)
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0

    # page break
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    run = p.add_run()
    run.add_break(WD_BREAK.PAGE)


def build_toc(doc, headings):
    p = doc.add_paragraph()
    r = p.add_run("目 录")
    set_run_font(r, HEAD_FONT, 22, GREEN, bold=True)
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(4)

    p = doc.add_paragraph()
    r = p.add_run("先读第 1 章与第 12 章，可以最快拿到简历素材；面试前重点看第 12.5 节。")
    set_run_font(r, BODY_FONT, 9.5, GRAY)
    p.paragraph_format.space_after = Pt(12)

    for h in headings:
        if not re.match(r"^(0|1|2|3|4|5|6|7|8|9|10|11|12|附录)", h):
            continue
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(7)
        p.paragraph_format.line_spacing = 1.15
        m = re.match(r"^(\d+)\s*[\.、]?\s*(.*)$", h)
        if m:
            num, rest = m.group(1), m.group(2)
            r = p.add_run(num.rjust(2, "0") + "  ")
            set_run_font(r, HEAD_FONT, 11, GREEN, bold=True)
            r2 = p.add_run(rest)
            set_run_font(r2, HEAD_FONT, 11, INK)
        else:
            r = p.add_run(h)
            set_run_font(r, HEAD_FONT, 11, GREEN, bold=True)

    # hint box
    doc.add_paragraph()
    table = doc.add_table(rows=1, cols=1)
    set_table_no_borders(table)
    cell = table.cell(0, 0)
    shade_cell(cell, BG_LIGHT)
    set_cell_borders(cell, GREEN_HEX, 24, ("left",))
    set_cell_margins(table, 90, 90, 150, 120)
    p = cell.paragraphs[0]
    add_inline_runs(p, "**阅读建议**：这是一份「可核验」的项目方案——所有数字都能在仓库或线上找到出处；"
                       "写简历时请重点看第 1、10、12 章，以及独立的《简历素材卡》。", 9.5, BODY)

    p = doc.add_paragraph()
    from docx.enum.text import WD_BREAK
    p.add_run().add_break(WD_BREAK.PAGE)


# ---------------------------------------------------------------- main


def setup_document(header_title="点定旅途 · 完整项目方案", first_page_diff=True):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Cm(21)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.2)
    sec.bottom_margin = Cm(2.0)
    sec.left_margin = Cm(MARGIN_L)
    sec.right_margin = Cm(MARGIN_R)
    sec.header_distance = Cm(1.1)
    sec.footer_distance = Cm(1.0)

    normal = doc.styles["Normal"]
    style_run_font(normal, BODY_FONT, 10.5, BODY)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.space_after = Pt(4)

    for idx, size in ((1, 17), (2, 13), (3, 11.5)):
        st = doc.styles["Heading %d" % idx]
        style_run_font(st, HEAD_FONT, size, GREEN if idx != 2 else INK, bold=True)
        st.paragraph_format.keep_with_next = True

    # header / footer
    sec.different_first_page_header_footer = first_page_diff
    header = sec.header
    hp = header.paragraphs[0]
    hp.paragraph_format.tab_stops.add_tab_stop(Cm(USABLE), WD_TAB_ALIGNMENT.RIGHT)
    r = hp.add_run(header_title)
    set_run_font(r, HEAD_FONT, 8.5, GREEN, bold=True)
    r = hp.add_run("\t2026.10 · v1.0")
    set_run_font(r, HEAD_FONT, 8.5, GRAY)
    add_paragraph_bottom_border(hp, LINE, 4, 4)

    footer = sec.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = fp.add_run("— 第 ")
    set_run_font(r, HEAD_FONT, 8.5, GRAY)
    add_field(fp, "PAGE")
    r = fp.add_run(" 页 · 共 ")
    set_run_font(r, HEAD_FONT, 8.5, GRAY)
    add_field(fp, "NUMPAGES")
    r = fp.add_run(" 页 —")
    set_run_font(r, HEAD_FONT, 8.5, GRAY)

    cp = doc.core_properties
    cp.title = header_title
    cp.subject = "AI 旅行路线规划产品 · 项目方案与简历素材"
    cp.author = "点定旅途项目"
    cp.comments = "2026-10-19 · v1.0"
    return doc


def main(argv=None):
    argv = argv or sys.argv[1:]
    src = argv[0] if len(argv) > 0 else SRC
    dst = argv[1] if len(argv) > 1 else DST
    header_title = argv[2] if len(argv) > 2 else HEADER_TITLE
    plain = len(argv) > 3 and argv[3] == "plain"

    with open(src, "r", encoding="utf-8") as f:
        md = f.read()

    if plain:
        body = md
        blocks = parse_blocks(body)
        doc = setup_document(header_title, False)
        renderer = Renderer(doc)
    else:
        idx = md.find("\n## ")
        if idx == -1:
            print("未找到正文起始位置")
            return 1
        body = md[idx + 1:]
        blocks = parse_blocks(body)
        headings = [b["text"] for b in blocks if b["type"] == "heading" and b["level"] == 2]
        doc = setup_document(header_title)
        build_cover(doc)
        build_toc(doc, headings)
        renderer = Renderer(doc)
    i = 0
    while i < len(blocks):
        b = blocks[i]
        t = b["type"]
        if t == "pagebreak":
            renderer.pending_break = True
            i += 1
            continue
        if t == "heading":
            renderer.heading(b["level"], b["text"])
        elif t == "para":
            renderer.para(b["text"])
        elif t == "bullets":
            renderer.bullets(b["items"])
        elif t == "numbered":
            renderer.numbered(b["text"])
        elif t == "quote":
            renderer.quote(b["lines"])
        elif t == "code":
            renderer.code(b["lines"])
        elif t == "table":
            renderer.table(b["rows"])
        elif t == "image":
            imgs = [b]
            j = i + 1
            while j < len(blocks) and blocks[j]["type"] == "image":
                imgs.append(blocks[j])
                j += 1
            renderer.image_groups(imgs)
            i = j
            continue
        i += 1

    doc.save(dst)
    print("saved:", dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
