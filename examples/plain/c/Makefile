# 无元数据 C 演示：不链接 DrawcodeMeta.c，也没有 @drawcode 注释。
#
# 默认用本机已验证的 Linux 交叉工具链；换机器时可以在命令行覆盖：
#   make CC=gcc AR=ar
#
# 这里用 := 而不是 ?=：make 内置了 CC=cc 与 AR=ar，?= 会因为变量已定义而
# 不生效，最终仍然调用不存在的 cc。
CC := x86_64-unknown-linux-gnu-gcc
AR := x86_64-unknown-linux-gnu-ar

# -O0 -g 让符号表和调试信息保持完整；这不是性能演示，而是读取器的输入样本。
CFLAGS ?= -std=c11 -Wall -Wextra -O0 -g -fno-common
# 链接后默认不保留 .rela.text；没有它，读取器无法推断“哪个函数访问了哪个信号”。
LDFLAGS ?= -Wl,--emit-relocs

all: sensor.o main.o libplain.a libplain.so plain.out

sensor.o: sensor.c sensor.h
	$(CC) $(CFLAGS) -c sensor.c -o $@

main.o: main.c sensor.h
	$(CC) $(CFLAGS) -c main.c -o $@

# 静态库：两个成员都能被 ar 读取器逐个解析，其中 main.o 没有导出信号。
libplain.a: sensor.o main.o
	$(AR) rcs $@ $^

# 共享库保留完整 .symtab；即使被 strip 成只剩 .dynsym，读取器也会退回动态符号表。
libplain.so: sensor.c main.c sensor.h
	$(CC) $(CFLAGS) -fPIC $(LDFLAGS) -shared sensor.c main.c -o $@

plain.out: sensor.o main.o
	$(CC) $(CFLAGS) $(LDFLAGS) sensor.o main.o -o $@

clean:
	rm -f sensor.o main.o libplain.a libplain.so plain.out

.PHONY: all clean
