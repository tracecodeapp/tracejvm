import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Random;

public final class HotAotOracle {
  private static long digest = 0xcbf29ce484222325L;

  private static void mix(int value) {
    digest ^= Integer.toUnsignedLong(value);
    digest *= 0x100000001b3L;
  }

  private static int latin1Hash(byte[] bytes) {
    int hash = 0;
    for (byte value : bytes) {
      hash = 31 * hash + Byte.toUnsignedInt(value);
    }
    return hash;
  }

  private static int naiveIndexOf(String source, String target, int fromIndex) {
    int start = Math.max(fromIndex, 0);
    if (target.isEmpty()) {
      return Math.min(start, source.length());
    }
    for (int index = start; index + target.length() <= source.length(); index++) {
      if (source.regionMatches(index, target, 0, target.length())) {
        return index;
      }
    }
    return -1;
  }

  private static int naiveLastIndexOf(String source, String target, int fromIndex) {
    int start = Math.min(fromIndex, source.length() - target.length());
    if (target.isEmpty()) {
      return Math.min(Math.max(fromIndex, -1), source.length());
    }
    for (int index = start; index >= 0; index--) {
      if (source.regionMatches(index, target, 0, target.length())) {
        return index;
      }
    }
    return -1;
  }

  private static int naiveIndexOfChar(String source, int value, int fromIndex) {
    if (value < 0 || value > 0xff) {
      return -1;
    }
    for (int index = Math.max(fromIndex, 0); index < source.length(); index++) {
      if (source.charAt(index) == value) {
        return index;
      }
    }
    return -1;
  }

  private static int naiveLastIndexOfChar(String source, int value, int fromIndex) {
    if (value < 0 || value > 0xff) {
      return -1;
    }
    for (int index = Math.min(fromIndex, source.length() - 1); index >= 0; index--) {
      if (source.charAt(index) == value) {
        return index;
      }
    }
    return -1;
  }

  private static void require(boolean condition, String detail) {
    if (!condition) {
      throw new AssertionError(detail);
    }
  }

  private static int manualCharIndex(char[] value, char needle, int fromIndex) {
    for (int index = Math.max(fromIndex, 0); index < value.length; index++) {
      if (value[index] == needle) {
        return index;
      }
    }
    return -1;
  }

  public static void main(String[] args) {
    for (int raw = Byte.MIN_VALUE; raw <= Byte.MAX_VALUE; raw++) {
      int actual = Byte.toUnsignedInt((byte) raw);
      int expected = raw & 0xff;
      require(actual == expected, "Byte.toUnsignedInt:" + raw);
      mix(actual);
    }

    Random random = new Random(0x54524143454a564dL);
    for (int iteration = 0; iteration < 2_000; iteration++) {
      int length = random.nextInt(257);
      byte[] leftBytes = new byte[length];
      random.nextBytes(leftBytes);
      byte[] rightBytes = leftBytes.clone();
      if (length > 0 && (iteration & 1) != 0) {
        rightBytes[random.nextInt(length)] ^= 1;
      }

      String left = new String(leftBytes, StandardCharsets.ISO_8859_1);
      String right = new String(rightBytes, StandardCharsets.ISO_8859_1);
      boolean expectedEquals = Arrays.equals(leftBytes, rightBytes);
      require(left.equals(right) == expectedEquals, "StringLatin1.equals:" + iteration);
      require(left.hashCode() == latin1Hash(leftBytes), "ArraysSupport.hash:" + iteration);
      mix(left.hashCode());
      mix(left.equals(right) ? 1 : 0);

      int needleLength = length == 0 ? 0 : random.nextInt(Math.min(length, 24) + 1);
      int needleStart =
          needleLength == 0 ? 0 : random.nextInt(length - needleLength + 1);
      byte[] needleBytes =
          Arrays.copyOfRange(leftBytes, needleStart, needleStart + needleLength);
      if (needleLength > 0 && (iteration % 3) == 0) {
        needleBytes[random.nextInt(needleLength)] ^= 0x20;
      }
      String needle = new String(needleBytes, StandardCharsets.ISO_8859_1);
      int fromIndex = random.nextInt(length + 17) - 8;
      int actualIndex = left.indexOf(needle, fromIndex);
      int actualLastIndex = left.lastIndexOf(needle, fromIndex);
      require(
          actualIndex == naiveIndexOf(left, needle, fromIndex),
          "StringLatin1.indexOf:" + iteration);
      require(
          actualLastIndex == naiveLastIndexOf(left, needle, fromIndex),
          "StringLatin1.lastIndexOf:" + iteration);
      mix(actualIndex);
      mix(actualLastIndex);

      int searchedValue =
          switch (iteration % 5) {
            case 0 -> -1;
            case 1 -> 0x100;
            default -> random.nextInt(0x100);
          };
      int actualCharIndex = left.indexOf(searchedValue, fromIndex);
      int actualCharLastIndex = left.lastIndexOf(searchedValue, fromIndex);
      require(
          actualCharIndex == naiveIndexOfChar(left, searchedValue, fromIndex),
          "StringLatin1.indexOfChar:" + iteration);
      require(
          actualCharLastIndex == naiveLastIndexOfChar(left, searchedValue, fromIndex),
          "StringLatin1.lastIndexOfChar:" + iteration);
      mix(actualCharIndex);
      mix(actualCharLastIndex);

      int minLeft = random.nextInt();
      int minRight = random.nextInt();
      int actualMin = Math.min(minLeft, minRight);
      require(actualMin == (minLeft <= minRight ? minLeft : minRight), "Math.min:" + iteration);
      mix(actualMin);
      int actualMax = Math.max(minLeft, minRight);
      require(actualMax == (minLeft >= minRight ? minLeft : minRight), "Math.max:" + iteration);
      mix(actualMax);
      int actualBitCount = Integer.bitCount(minLeft);
      int expectedBitCount = 0;
      for (int bit = 0; bit < Integer.SIZE; bit++) {
        expectedBitCount += (minLeft >>> bit) & 1;
      }
      require(actualBitCount == expectedBitCount, "Integer.bitCount:" + iteration);
      mix(actualBitCount);

      char[] latin1Chars = new char[length];
      for (int index = 0; index < length; index++) {
        latin1Chars[index] = (char) Byte.toUnsignedInt(leftBytes[index]);
      }
      String compressed = new String(latin1Chars);
      require(compressed.equals(left), "StringUTF16.compress:" + iteration);
      mix(compressed.hashCode());

      if (length > 0 && (iteration % 5) == 0) {
        char[] mixedChars = latin1Chars.clone();
        mixedChars[random.nextInt(length)] = '\u20ac';
        String mixed = new String(mixedChars);
        require(
            mixed.length() == mixedChars.length && mixed.indexOf('\u20ac') >= 0,
            "StringUTF16.compress-partial:" + iteration);
        mix(mixed.hashCode());
      }

      byte[] utf8Probe =
          (iteration & 1) == 0
              ? new byte[] {65, 66, 67, 68}
              : new byte[] {65, 66, (byte) 0xc3, (byte) 0xa9, 67};
      String decoded = new String(utf8Probe, StandardCharsets.UTF_8);
      require(
          decoded.equals((iteration & 1) == 0 ? "ABCD" : "AB\u00e9C"),
          "StringCoding.countPositives:" + iteration);
      mix(decoded.hashCode());
    }

    // Exercise public String behavior that repeatedly dispatches through the
    // package-private coder()/isLatin1() accessors. Alternate between compact
    // Latin-1 storage and UTF-16 storage, including unpaired surrogates whose
    // observable Java behavior must remain unchanged.
    for (int iteration = 0; iteration < 1_000; iteration++) {
      int length = random.nextInt(96);
      char[] chars = new char[length];
      for (int index = 0; index < length; index++) {
        chars[index] =
            switch (iteration % 4) {
              case 0 -> (char) random.nextInt(0x80);
              case 1 -> (char) random.nextInt(0x100);
              case 2 -> (char) (0x100 + random.nextInt(0x700));
              default -> (char) random.nextInt(0x10000);
            };
      }
      String value = new String(chars);
      require(value.length() == chars.length, "String.coder length:" + iteration);
      for (int index = 0; index < chars.length; index++) {
        require(value.charAt(index) == chars[index], "String.coder charAt:" + iteration);
      }
      int fromIndex = random.nextInt(length + 9) - 4;
      char needle = length == 0 ? '\u20ac' : chars[random.nextInt(length)];
      require(
          value.indexOf(needle, fromIndex) == manualCharIndex(chars, needle, fromIndex),
          "String.isLatin1 indexOf:" + iteration);
      int split = length == 0 ? 0 : random.nextInt(length + 1);
      require(
          value.substring(0, split).concat(value.substring(split)).equals(value),
          "String.coder substring:" + iteration);
      mix(value.hashCode());
      mix(value.indexOf(needle, fromIndex));
    }

    String latin1BoundsProbe = "TraceJVM";
    for (int invalidIndex : new int[] {-1, latin1BoundsProbe.length()}) {
      try {
        latin1BoundsProbe.charAt(invalidIndex);
        throw new AssertionError("StringLatin1.charAt accepted invalid index " + invalidIndex);
      } catch (StringIndexOutOfBoundsException expected) {
        require(expected.getMessage() != null, "StringLatin1.charAt exception message");
        mix(expected.getMessage().hashCode());
      }
    }

    int[] codePoints = {-1, 0, 0xffff, 0x10000, 0x10ffff, 0x110000, Integer.MAX_VALUE};
    for (int codePoint : codePoints) {
      int actual = Character.charCount(codePoint);
      int expected = codePoint >= 0x10000 ? 2 : 1;
      require(actual == expected, "Character.charCount:" + codePoint);
      mix(actual);
    }

    char[] surrogateProbes = {'\u0000', '\ud7ff', '\ud800', '\udfff', '\ue000', '\uffff'};
    for (char value : surrogateProbes) {
      boolean actual = Character.isSurrogate(value);
      boolean expected = value >= '\ud800' && value < '\ue000';
      require(actual == expected, "Character.isSurrogate:" + (int) value);
      mix(actual ? 1 : 0);
    }

    int[] integerSizeProbes = {
      Integer.MIN_VALUE, -1_000_000_000, -10, -1, 0, 1, 9, 10, 999_999_999, Integer.MAX_VALUE
    };
    for (int value : integerSizeProbes) {
      String rendered = Integer.toString(value);
      require(rendered.length() >= 1, "Integer.stringSize:" + value);
      mix(rendered.length());
    }

    char[][] coderProbes = {
      {},
      {'A'},
      {'A', '\u00ff'},
      {'A', '\u0100'},
      {'\ud800', '\udc00'}
    };
    for (char[] value : coderProbes) {
      String rendered = new String(value);
      require(rendered.length() == value.length, "StringUTF16.coderFromArrayLen:" + value.length);
      mix(rendered.hashCode());
    }

    byte[] largeBytes = new byte[5_000];
    random.nextBytes(largeBytes);
    String largeLeft = new String(largeBytes, StandardCharsets.ISO_8859_1);
    String largeRight = new String(largeBytes.clone(), StandardCharsets.ISO_8859_1);
    require(largeLeft.equals(largeRight), "large equality fallback");
    require(largeLeft.hashCode() == latin1Hash(largeBytes), "large hash fallback");
    mix(largeLeft.hashCode());

    System.out.println("hot-aot-ok:" + Long.toUnsignedString(digest, 16));
  }
}
