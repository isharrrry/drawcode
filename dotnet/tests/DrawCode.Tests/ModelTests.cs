namespace DrawCode.Tests;

public class ModelTests
{
    [Fact]
    public void RebuildEdges_DerivesReadsAndWrites()
    {
        var model = new Model();
        model.AddSignal(new Signal { Id = "a.h::g", Name = "g", CType = "int" });
        var f = new Func { Id = "a.h::f", Name = "f" };
        f.Reads.Add("a.h::g");
        f.Writes.Add("a.h::g");
        model.AddFunc(f);

        var edges = model.RebuildEdges();

        Assert.Equal(2, edges.Count);
        Assert.Equal(("a.h::g", "a.h::f", "read"), (edges[0].Src, edges[0].Dst, edges[0].Rw));
        Assert.Equal(("a.h::f", "a.h::g", "write"), (edges[1].Src, edges[1].Dst, edges[1].Rw));
    }
}
