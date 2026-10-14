using System.Globalization;
using System.Xml.Linq;

namespace DrawCode.Tests;

/// <summary>
/// Simulates the four edits a human makes in draw.io using structural XML edits, so the
/// tests exercise the same code path as a real round trip through the application.
/// </summary>
public class EditBackTests
{
    private static readonly string[] Names = ["adc.h", "adc.c", "dsp.h", "dsp.c"];

    private static string EditLikeDrawio(string xml)
    {
        var doc = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
        foreach (var o in doc.Descendants().Where(e => e.Name.LocalName == "object").ToList())
        {
            var sid = o.Attribute("symbolId")?.Value;
            if (sid == "adc.h::g_raw")
            {
                o.SetAttributeValue("alias", "原始采样");
                o.SetAttributeValue("dir", "out");
            }

            if (sid == "adc.h::adc_read")
            {
                var g = Geometry(o);
                g.SetAttributeValue("x", (Num(g, "x") + 100).ToString(CultureInfo.InvariantCulture));
                g.SetAttributeValue("y", (Num(g, "y") + 100).ToString(CultureInfo.InvariantCulture));
                g.SetAttributeValue("width", "220");
            }

            if (o.Attribute("src")?.Value == "adc.h::g_raw" && o.Attribute("dst")?.Value == "adc.h::adc_read")
            {
                var geom = Geometry(o);
                foreach (var old in geom.Elements().Where(e => e.Name.LocalName == "Array").ToList())
                {
                    old.Remove();
                }

                geom.Add(new XElement("Array",
                    new XAttribute("as", "points"),
                    new XElement("mxPoint", new XAttribute("x", "180"), new XAttribute("y", "150"))));
            }
        }

        return doc.ToString(SaveOptions.DisableFormatting);
    }

    private static XElement Geometry(XElement obj) =>
        obj.Elements().First(e => e.Name.LocalName == "mxCell")
           .Elements().First(e => e.Name.LocalName == "mxGeometry");

    private static double Num(XElement el, string name) =>
        double.Parse(el.Attribute(name)!.Value, NumberStyles.Float, CultureInfo.InvariantCulture);

    private static (string Dir, string[] Paths) Setup() => Fixture.CopyCase("small-c", Names);

    [Fact]
    public void EditedDrawioFlowsBackIntoCode()
    {
        var (dir, paths) = Setup();
        try
        {
            var xml = Drawio.ToDrawio(ParseDispatch.ParseAny(paths, dir));
            Assert.Contains("alias=\"原始采样值\"", xml);
            Assert.Contains("dir=\"in\"", xml);
            Assert.Contains("int16_t g_raw;", Fixture.Read(Path.Combine(dir, "adc.h")));

            var layout = Drawio.ReadLayout(EditLikeDrawio(xml));
            var m = ParseDispatch.ParseAny(paths, dir);
            Drawio.ApplyLayout(m, layout);
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m, Path.GetFileName(p));
            }

            var header = Fixture.Read(Path.Combine(dir, "adc.h"));
            Assert.Contains("alias=\"原始采样\"", header);
            Assert.DoesNotContain("alias=\"原始采样值\"", header);
            Assert.Contains("dir=out", header);
            Assert.DoesNotContain("dir=in", header);
            Assert.Contains("#include <stdint.h>", header);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void EditedLayoutSurvivesAndEdgeGetsWaypoints()
    {
        var (dir, paths) = Setup();
        try
        {
            var xml = Drawio.ToDrawio(ParseDispatch.ParseAny(paths, dir));
            var before = Drawio.ReadLayout(xml).Nodes["adc.h::adc_read"];
            var layout = Drawio.ReadLayout(EditLikeDrawio(xml));
            var after = layout.Nodes["adc.h::adc_read"];

            Assert.Equal(before.X + 100, after.X);
            Assert.Equal(before.Y + 100, after.Y);
            Assert.Equal(220.0, after.W);

            // mxPoint and mxGeometry live in the same parent-relative frame; read-back unifies both.
            var doc = XDocument.Parse(xml);
            var rel = doc.Descendants()
                .First(e => e.Name.LocalName == "object" && e.Attribute("symbolId")?.Value == "adc.h::adc_read");
            var geom = Geometry(rel);
            var ox = before.X - Num(geom, "x");
            var oy = before.Y - Num(geom, "y");

            Assert.Equal(
                [(180.0 + ox, 150.0 + oy)],
                layout.Edges["adc.h::g_raw->adc.h::adc_read:read"]);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void RoundTripAfterEditIsStable()
    {
        var (dir, paths) = Setup();
        try
        {
            var xml = Drawio.ToDrawio(ParseDispatch.ParseAny(paths, dir));
            var m1 = ParseDispatch.ParseAny(paths, dir);
            Drawio.ApplyLayout(m1, Drawio.ReadLayout(EditLikeDrawio(xml)));
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m1, Path.GetFileName(p));
            }

            var first = paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal);

            var m2 = ParseDispatch.ParseAny(paths, dir);
            foreach (var p in paths)
            {
                CodeGen.SyncSource(p, m2, Path.GetFileName(p));
            }

            Assert.Equal(first, paths.ToDictionary(p => Path.GetFileName(p)!, p => Fixture.Read(p), StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void EditingADrawioFileOnDisk()
    {
        var (dir, paths) = Setup();
        try
        {
            var path = Path.Combine(dir, "g.drawio");
            Text.WriteText(path, Drawio.ToDrawio(ParseDispatch.ParseAny(paths, dir)));
            Text.WriteText(path, EditLikeDrawio(Text.ReadSource(path)));

            var layout = Drawio.ReadLayout(Text.ReadSource(path));
            var m = ParseDispatch.ParseAny(paths, dir);
            Drawio.ApplyLayout(m, layout);
            CodeGen.SyncSource(Path.Combine(dir, "adc.h"), m, "adc.h");

            Assert.Contains("dir=out", Fixture.Read(Path.Combine(dir, "adc.h")));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void RoundTripThroughTheCliIsStable()
    {
        var (dir, paths) = Setup();
        try
        {
            var drawio = Path.Combine(dir, "flow.drawio");
            var svg = Path.Combine(dir, "flow.svg");
            var args = new List<string> { "build" };
            args.AddRange(paths);
            // 两个模块要合成一张图才有「一个 --out / 一个 SVG」可言 —— 默认是一模块一张图
            args.AddRange(["--root", dir, "--merge", "--out", drawio, "--svg", svg]);
            Assert.Equal(0, Cli.Run([.. args]));

            var drawio2 = Path.Combine(dir, "flow2.drawio");
            var args2 = new List<string> { "build" };
            args2.AddRange(paths);
            args2.AddRange(["--root", dir, "--merge", "--out", drawio2, "--layout-from", drawio]);
            Assert.Equal(0, Cli.Run([.. args2]));

            Assert.Equal(Text.ReadSource(drawio), Text.ReadSource(drawio2));
            Assert.True(File.Exists(svg));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SyncDryRunThenWrite()
    {
        var (dir, paths) = Setup();
        try
        {
            var drawio = Path.Combine(dir, "flow.drawio");
            var build = new List<string> { "build" };
            build.AddRange(paths);
            build.AddRange(["--root", dir, "--merge", "--out", drawio]);
            Assert.Equal(0, Cli.Run([.. build]));

            var before = Fixture.Read(Path.Combine(dir, "adc.h"));
            var dry = new List<string> { "sync", drawio };
            dry.AddRange(paths);
            dry.AddRange(["--root", dir]);
            Assert.Equal(0, Cli.Run([.. dry]));
            Assert.Equal(before, Fixture.Read(Path.Combine(dir, "adc.h")));

            var write = new List<string> { "sync", drawio };
            write.AddRange(paths);
            write.AddRange(["--root", dir, "--write"]);
            Assert.Equal(0, Cli.Run([.. write]));
            Assert.Equal(before, Fixture.Read(Path.Combine(dir, "adc.h")));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
