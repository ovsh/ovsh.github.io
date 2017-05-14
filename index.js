$(document).ready(function() {
  $("#idf").hide();
  $("#vc").hide();
  $("#nu").hide();
  $("#spotlight").hide();
  $("#reshaped").hide();
  $("#ngp").hide();
  $("#dog").hide();

  $("#idf-btn").click(function() {
    $("#idf").show();
    $("#vc").hide();
    $("#nu").hide();
    $("#spotlight").hide();
    $("#reshaped").hide();
    $("#ngp").hide();
    $("#dog").hide();
  });

  $("#vc-btn").click(function() {
    $("#idf").hide();
    $("#vc").show();
    $("#nu").hide();
    $("#spotlight").hide();
    $("#reshaped").hide();
    $("#ngp").hide();
    $("#dog").hide();
  });

  $("#nu-btn").click(function() {
    $("#idf").hide();
    $("#vc").hide();
    $("#nu").show();
    $("#spotlight").hide();
    $("#reshaped").hide();
    $("#ngp").hide();
    $("#dog").hide();
  });

  $("#spotlight-btn").click(function() {
    $("#idf").hide();
    $("#vc").hide();
    $("#nu").hide();
    $("#spotlight").show();
    $("#reshaped").hide();
    $("#ngp").hide();
    $("#dog").hide();
  });

  $("#reshaped-btn").click(function() {
    $("#idf").hide();
    $("#vc").hide();
    $("#nu").hide();
    $("#spotlight").hide();
    $("#reshaped").show();
    $("#ngp").hide();
    $("#dog").hide();
  });

  $("#ngp-btn").click(function() {
    $("#idf").hide();
    $("#vc").hide();
    $("#nu").hide();
    $("#spotlight").hide();
    $("#reshaped").hide();
    $("#ngp").show();
    $("#dog").hide();
  });

  $("#dog-btn").click(function() {
    $("#idf").hide();
    $("#vc").hide();
    $("#nu").hide();
    $("#spotlight").hide();
    $("#reshaped").hide();
    $("#ngp").hide();
    $("#dog").show();
  });
});
