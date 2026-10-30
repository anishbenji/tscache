# Chart libraries

A read's columns are what chart libraries take: one `Float64Array` of timestamps and one typed array per
field, equal lengths, no holes. Ranges are inclusive at both ends, as Lightweight Charts'
`setVisibleRange` and uPlot's scale `min`/`max` report them, so a chart's visible range goes straight
into `get`. Two adaptations remain: the time unit (tscache uses milliseconds; Lightweight Charts takes seconds,
and uPlot takes milliseconds once its `ms` option is `1`) and the row shape a library wants.

The reference clients draw with either library behind one small interface:

<<< ../../reference/shared/src/chart/view.ts{ts}

## Reading around the screen

Read a little more than is on screen, so a short scroll is answered from the cache, and only after the
user pauses (the reference clients wait 150 ms). The cache fetches only what it does not hold, and the
grid snap means a fractional visible range needs no rounding.

<<< ../../reference/shared/src/market.ts{ts}

## Lightweight Charts

[`reference/shared/src/chart/lightweight.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/chart/lightweight.ts) turns a
result into candlestick rows and keeps the visible range across redraws.

<<< ../../reference/shared/src/chart/lightweight.ts{ts}

## uPlot

[`reference/shared/src/chart/uplot.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/chart/uplot.ts) gives uPlot columnar data
directly, with `ms: 1`, so the timestamps go in as they are.

<<< ../../reference/shared/src/chart/uplot.ts{ts}

## Gaps on a chart

A confirmed gap has no points, so a chart draws nothing there; a time-scaled axis (uPlot) shows the gap,
an index-scaled one (Lightweight Charts) closes it up. `misses` tells you which stretches are merely not
loaded yet, if you want to mark them.
