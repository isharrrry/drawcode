# 四个目标覆盖读取器需要支持的产物形态：
#   app.o      未链接的目标文件（没有 anchor，读取器接受版本未知）
#   libapp.a   静态库（ar 归档，成员逐个解析）
#   libapp.so  共享库（链接了 DrawcodeMeta.c，含 anchor）
#   app.out    可执行文件（同上）
#
# 刻意不加 -flto：LTO 会把段合并进临时分区，第一版不做特殊处理；
# 需要在 README 里明确说明。

CC ?= cc
AR ?= ar
CFLAGS ?= -std=c11 -Wall -Wextra -O2
CPPFLAGS += -I..
MODULE = -DDC_META_MODULE='"demo"'

all: app.o libapp.a libapp.so app.out

app.o: app.c ../DrawcodeMeta.h
	$(CC) $(CFLAGS) $(CPPFLAGS) $(MODULE) -c app.c -o $@

main.o: main.c
	$(CC) $(CFLAGS) $(MODULE) -c main.c -o $@

meta.o: ../DrawcodeMeta.c ../DrawcodeMeta.h
	$(CC) $(CFLAGS) $(CPPFLAGS) $(MODULE) -c ../DrawcodeMeta.c -o $@

libapp.a: app.o main.o meta.o
	$(AR) rcs $@ $^

libapp.so: app.c main.c ../DrawcodeMeta.c ../DrawcodeMeta.h
	$(CC) $(CFLAGS) $(CPPFLAGS) $(MODULE) -fPIC -shared app.c main.c ../DrawcodeMeta.c -o $@

app.out: app.c main.c ../DrawcodeMeta.c ../DrawcodeMeta.h
	$(CC) $(CFLAGS) $(CPPFLAGS) $(MODULE) app.c main.c ../DrawcodeMeta.c -o $@

clean:
	rm -f app.o main.o meta.o libapp.a libapp.so app.out

.PHONY: all clean
